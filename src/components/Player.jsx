import { useEffect, useRef, useState } from 'react';
// Versión liviana: sin subtítulos, DRM ni pistas alternas (no se usan)
import Hls from 'hls.js/light';
import { relayAvailable, relayHlsUrl } from '../lib/relay';
import Icon from './Icon';
import WebEmbed from './WebEmbed';

// Errores HTTP de la lista: el servidor de esa opción no responde
const isDeadHttp = (code) => code === 0 || code === 403 || code === 404 || code >= 500;
// Reproduciendo sin imagen durante este tiempo → el video no se decodifica
const NO_VIDEO_MS = 4000;
// Servidor más lento que la señal: si los últimos SLOW_FRAGS segmentos tardaron
// en bajar en promedio más de SLOW_RATIO de lo que duran (y no hay calidad más
// baja a la cual bajar), se pasa a la retransmisión, que los baja en paralelo.
const SLOW_FRAGS = 4;
const SLOW_RATIO = 0.85;

/**
 * Reproduce la opción actual con el motor que decidió useStreamRecovery.
 *  - hls / relay: hls.js (o el HLS nativo de Safari)
 *  - ts:          mpegts.js (señales TS directas)
 *  - web:         iframe (Kick, YouTube, Twitch)
 * Avisa a la recuperación con onProgress / onPlaying / onFail.
 */
export default function Player({
    source,
    engine,
    relayVideo,
    playerKey,
    probing,
    paused,
    muted,
    volume = 1,
    slowMode,
    maxBitRate,
    hasAlternatives,
    videoRef,
    onProgress,
    onPlaying,
    onFail,
    onBandwidth,
    onAutoplayBlocked,
}) {
    const hlsRef = useRef(null);
    const cb = useRef({});
    cb.current = { onProgress, onPlaying, onFail, onBandwidth, onAutoplayBlocked, maxBitRate };
    const [, force] = useState(0);

    const isStream = source && engine && engine !== 'web';
    const url = isStream
        ? engine === 'relay'
            ? relayHlsUrl(source.url, relayVideo)
            : source.url
        : null;

    // ── Crear el motor ──────────────────────────────────────────────────
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !url || probing) return;
        let destroyed = false;
        let hls = null;
        let ts = null;
        let mediaRecoveries = [];

        const report = (reason, info) => {
            if (!destroyed) cb.current.onFail?.(reason, info);
        };

        if (engine === 'ts') {
            // mpegts.js se carga solo cuando hace falta (pocas señales lo usan)
            import('mpegts.js')
                .then(({ default: mpegts }) => {
                    if (destroyed) return;
                    if (!mpegts.isSupported()) {
                        report('error', { compat: true, detail: 'mpegts no soportado' });
                        return;
                    }
                    ts = mpegts.createPlayer(
                        { type: 'mpegts', isLive: true, url },
                        {
                            enableWorker: true,
                            lazyLoad: false,
                            autoCleanupSourceBuffer: true,
                            liveBufferLatencyChasing: true,
                            liveBufferLatencyMaxLatency: slowMode ? 20 : 8,
                            liveBufferLatencyMinRemain: slowMode ? 6 : 2,
                        },
                    );
                    ts.on(mpegts.Events.ERROR, (type, detail) => {
                        if (type === mpegts.ErrorTypes.NETWORK_ERROR) {
                            report('error', {
                                dead: /HttpStatus|Connecting|Unrecoverable/i.test(detail),
                                detail,
                            });
                        } else {
                            report('error', { compat: true, detail });
                        }
                    });
                    ts.attachMediaElement(video);
                    ts.load();
                })
                .catch(() => report('error', { detail: 'no se pudo cargar mpegts.js' }));
        } else if (Hls.isSupported()) {
            hls = new Hls({
                backBufferLength: 0,
                liveSyncDurationCount: slowMode ? 6 : 3,
                maxBufferLength: slowMode ? 60 : 30,
                maxMaxBufferLength: slowMode ? 90 : 60,
                capLevelToPlayerSize: true,
                // Arrancar suponiendo buena conexión (por defecto 500 kbps: empezaba
                // en la peor calidad y tardaba en subir). Si no da, el ABR baja solo.
                abrEwmaDefaultEstimate: slowMode ? 1000000 : 5000000,
                manifestLoadingMaxRetry: 2,
                levelLoadingMaxRetry: 4,
                fragLoadingMaxRetry: 4,
            });
            hlsRef.current = hls;
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                const cap = cb.current.maxBitRate;
                if (cap) applyCap(hls, cap);
                force((n) => n + 1);
            });
            const loadRatios = [];
            hls.on(Hls.Events.FRAG_LOADED, (e, data) => {
                cb.current.onBandwidth?.(hls.bandwidthEstimate);
                const frag = data?.frag;
                const t = frag?.stats?.loading;
                if (!frag?.duration || !t?.end || !t?.start) return;
                loadRatios.push((t.end - t.start) / 1000 / frag.duration);
                if (loadRatios.length > SLOW_FRAGS) loadRatios.shift();
                const avg = loadRatios.reduce((a, b) => a + b, 0) / loadRatios.length;
                const lowest = hls.levels.length <= 1 || hls.currentLevel === 0;
                if (engine === 'hls' && loadRatios.length === SLOW_FRAGS && avg > SLOW_RATIO && lowest && relayAvailable()) {
                    loadRatios.length = 0;
                    report('error', { compat: true, detail: `servidor lento (${avg.toFixed(2)}x)` });
                }
            });
            hls.on(Hls.Events.ERROR, (e, data) => {
                if (data.details === Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR) {
                    report('error', { compat: true, detail: data.details });
                    return;
                }
                if (!data.fatal) return;
                if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                    // Recuperación en el mismo player (sin rearmar): primero
                    // recoverMediaError, luego cambiando el códec de audio
                    const now = Date.now();
                    mediaRecoveries = mediaRecoveries.filter((t) => now - t < 15000);
                    mediaRecoveries.push(now);
                    if (mediaRecoveries.length === 1) hls.recoverMediaError();
                    else if (mediaRecoveries.length === 2) {
                        hls.swapAudioCodec();
                        hls.recoverMediaError();
                    } else report('error', { compat: true, detail: data.details });
                    return;
                }
                if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                    const code = data.response?.code ?? 0;
                    const manifest = /manifest/i.test(data.details);
                    report('error', {
                        dead: manifest && isDeadHttp(code),
                        detail: `${data.details} ${code}`,
                    });
                    return;
                }
                report('error', { detail: data.details });
            });
            hls.loadSource(url);
            hls.attachMedia(video);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari / iPhone: HLS nativo
            video.src = url;
        } else {
            report('error', { compat: true, detail: 'HLS no soportado' });
            return;
        }

        // Video que el navegador no decodifica (MPEG-2, HEVC): hls.js/mpegts lo
        // descartan sin avisar y suena solo el audio. Si tras unos segundos
        // avanzando no hay imagen, es un error de compatibilidad (→ H.264).
        let noVideoTimer = null;
        const checkVideo = () => {
            if (noVideoTimer) return;
            noVideoTimer = setTimeout(() => {
                if (video.readyState >= 2 && !video.videoWidth) {
                    report('error', { compat: true, relayVideo: 'h264', detail: 'sin imagen (solo audio)' });
                }
            }, NO_VIDEO_MS);
        };
        const onTime = () => {
            checkVideo();
            cb.current.onProgress?.(video.currentTime);
        };
        const onPlay = () => cb.current.onPlaying?.();
        const onEnded = () => report('ended');
        const onError = () => {
            const err = video.error;
            if (!err || hls) return; // con hls.js los errores llegan por su evento
            const compat = err.code === 3 || err.code === 4;
            report('error', { compat, detail: `media ${err.code}` });
        };
        video.addEventListener('timeupdate', onTime);
        video.addEventListener('playing', onPlay);
        video.addEventListener('ended', onEnded);
        video.addEventListener('error', onError);

        return () => {
            destroyed = true;
            clearTimeout(noVideoTimer);
            video.removeEventListener('timeupdate', onTime);
            video.removeEventListener('playing', onPlay);
            video.removeEventListener('ended', onEnded);
            video.removeEventListener('error', onError);
            if (hls) hls.destroy();
            hlsRef.current = null;
            if (ts) {
                try {
                    ts.pause();
                    ts.unload();
                    ts.detachMediaElement();
                    ts.destroy();
                } catch {}
            }
            video.removeAttribute('src');
            video.load();
        };
        // playerKey rearma el motor (reintento)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url, engine, playerKey, probing, slowMode]);

    // ── Tope de calidad (sin rearmar) ───────────────────────────────────
    useEffect(() => {
        if (hlsRef.current) applyCap(hlsRef.current, maxBitRate);
    }, [maxBitRate]);

    // ── Pausa / reproducción ────────────────────────────────────────────
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !isStream) return;
        if (paused) {
            video.pause();
            return;
        }
        const tryPlay = () =>
            video.play().catch((e) => {
                // El navegador no deja arrancar con sonido: arrancar silenciado
                if (e?.name === 'NotAllowedError' && !video.muted) {
                    video.muted = true;
                    cb.current.onAutoplayBlocked?.();
                    video.play().catch(() => {});
                }
            });
        tryPlay();
        video.addEventListener('canplay', tryPlay, { once: true });
        return () => video.removeEventListener('canplay', tryPlay);
    }, [paused, isStream, url, playerKey, probing, videoRef]);

    useEffect(() => {
        if (videoRef.current) videoRef.current.muted = muted;
    }, [muted, videoRef, url, playerKey]);

    useEffect(() => {
        if (videoRef.current) videoRef.current.volume = volume;
    }, [volume, videoRef, url, playerKey]);

    if (!source) return null;

    return (
        <>
            <video
                ref={videoRef}
                className="video"
                playsInline
                autoPlay
                muted={muted}
                style={engine === 'web' ? { display: 'none' } : undefined}
            />
            {engine === 'web' && (
                <WebEmbed
                    key={`${source.url}-${playerKey}`}
                    url={source.url}
                    muted={muted}
                    volume={volume}
                    onAutoplayBlocked={() => cb.current.onAutoplayBlocked?.()}
                    hasAlternatives={hasAlternatives}
                    onLoaded={onPlaying}
                    onFail={onFail}
                />
            )}
        </>
    );
}

/** Tope de calidad: el nivel más alto que no pase de `cap` bits/s (0 = sin tope). */
function applyCap(hls, cap) {
    const levels = hls.levels || [];
    if (!cap || levels.length < 2) {
        hls.autoLevelCapping = -1;
        return;
    }
    let idx = 0;
    levels.forEach((l, i) => {
        if (l.bitrate <= cap) idx = i;
    });
    hls.autoLevelCapping = idx;
}

/** Indicador y avisos de estado sobre el video. */
export function StatusOverlay({ status, quiet, paused, channel, sourceIndex, onRetry }) {
    if (paused) return null;
    if (quiet) {
        return (
            <div className="quiet-spinner" aria-hidden="true">
                <span className="spinner spinner-sm" />
            </div>
        );
    }
    if (status === 'playing') return null;
    const count = channel?.sources.length ?? 0;
    if (status === 'failed') {
        return (
            <div className="status status-dark" role="status">
                <div className="status-icon">
                    <Icon name="dish" size={26} />
                </div>
                <p className="status-title">Señal no disponible</p>
                <p className="status-sub">
                    {count > 1
                        ? 'Ninguna opción responde. Seguimos intentando solos.'
                        : 'Seguimos intentando automáticamente.'}
                </p>
                <button className="btn-tonal" onClick={onRetry}>
                    <Icon name="rotate" size={14} /> Reintentar ahora
                </button>
            </div>
        );
    }
    return (
        <div className="status" role="status">
            <span className="spinner" />
            <p className="status-title">
                {status === 'reconnecting' ? 'Reconectando…' : 'Conectando…'}
            </p>
            {count > 1 && (
                <span className="status-chip">
                    Opción {sourceIndex + 1} de {count}
                </span>
            )}
        </div>
    );
}
