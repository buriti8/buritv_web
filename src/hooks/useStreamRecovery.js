import { useEffect, useRef, useCallback, useState } from 'react';
import {
    STALL_MS,
    START_TIMEOUT_MS,
    RETRY_BACKOFF_MS,
    FAILED_RETRY_MS,
    WATCHDOG_MS,
    FLAP_LIMIT,
    FLAP_WINDOW_MS,
    STALL_MS_SLOW,
    START_TIMEOUT_MS_SLOW,
    SLOW_MAX_BITRATE,
    BITRATE_STEPS,
} from '../config';
import { cachedProbe, probe } from '../lib/tsProbe';
import { relayAvailable, checkRelay } from '../lib/relay';
import { showToast } from '../lib/toast';

/**
 * La misma recuperación de la app, con los motores de la web:
 *
 *  engine: 'hls'   hls.js (o HLS nativo en Safari)
 *          'ts'    mpegts.js, para señales TS directas
 *          'relay' retransmisión local: la señal pasa por ffmpeg en el PC
 *                  (audio MP2 → AAC, video MPEG-2 → H.264)
 *          'web'   embeds (Kick, YouTube, Twitch) en un iframe
 *  status: 'loading' | 'playing' | 'reconnecting' | 'failed'
 *
 *  Antes de la primera reproducción de cada enlace se revisan sus códecs
 *  (una sola vez, queda guardado): si el navegador no puede con ellos, va
 *  directo por la retransmisión.
 *
 *  Ante un error, un fin, un corte (sin avance en STALL_MS) o una opción que
 *  no arranca (START_TIMEOUT_MS):
 *   0. Error de compatibilidad (el navegador no decodifica) → retransmisión.
 *   1. Si ya reproducía: reintenta la misma opción (microcorte).
 *   2. Si el servidor no está caído → misma opción por la retransmisión.
 *   3. Otra opción del canal, la más estable que falte probar.
 *   4. Ninguna responde → 'failed' y sigue intentando cada FAILED_RETRY_MS.
 */
export default function useStreamRecovery({
    current,
    source,
    sourceIndex,
    selectSource,
    paused,
    getEnginePref,
    onSourceWorking,
    rankSources,
    onSourceResult,
    onStall,
    slowMode,
}) {
    const [status, setStatus] = useState('loading');
    const [playerKey, setPlayerKey] = useState(0);
    const [engineOverride, setEngineOverride] = useState(null); // { url, engine, relayVideo }
    const [bitrateCaps, setBitrateCaps] = useState({});
    // Revisión de códecs en curso para la opción actual
    const [probing, setProbing] = useState(false);
    const [probeTick, setProbeTick] = useState(0);

    const isStream = source && source.type !== 'web';
    const probed = isStream ? cachedProbe(source.url) : null;
    const pref = isStream ? getEnginePref?.(source.url) : null;
    const defaultEngine = isStream && /\.m3u8?(\?|$)/i.test(source.url) ? 'hls' : 'ts';

    let engine = null;
    if (source) {
        if (source.type === 'web') engine = 'web';
        else if (engineOverride?.url === source.url) engine = engineOverride.engine;
        else if (probed?.needsRelay && relayAvailable()) engine = 'relay';
        else if (pref && (pref !== 'relay' || relayAvailable())) engine = pref;
        else engine = defaultEngine;
    }
    const relayVideo =
        engineOverride?.url === source?.url && engineOverride?.relayVideo
            ? engineOverride.relayVideo
            : probed?.relayVideo || 'copy';

    const caps = [source && bitrateCaps[source.url], slowMode && SLOW_MAX_BITRATE].filter(Boolean);
    const maxBitRate = caps.length ? Math.min(...caps) : 0;

    const statusRef = useRef(status);
    statusRef.current = status;

    const attempts = useRef(0);
    const tried = useRef(new Set());
    const playedThisSource = useRef(false);
    const recentFails = useRef([]);
    const lastProgressAt = useRef(Date.now());
    const lastTime = useRef(null);
    const retryTimer = useRef(null);
    const noAudioWarned = useRef(new Set());

    const live = useRef({});
    live.current = {
        current,
        source,
        sourceIndex,
        selectSource,
        paused,
        engine,
        onSourceWorking,
        rankSources,
        onSourceResult,
        onStall,
        slowMode,
        probing,
    };

    const clearRetry = () => {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
    };

    const schedule = useCallback((wait, fn) => {
        clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => {
            retryTimer.current = null;
            fn();
        }, wait);
    }, []);

    // ¿Está encendida la retransmisión? (se revisa al abrir y luego cada tanto)
    useEffect(() => {
        checkRelay().then(() => setProbeTick((t) => t + 1));
    }, []);

    // ── Revisar los códecs de un enlace que nunca se revisó ─────────────
    useEffect(() => {
        if (!isStream || probed || pref) {
            setProbing(false);
            return;
        }
        let cancelled = false;
        setProbing(true);
        Promise.all([probe(source.url), checkRelay()]).then(([result]) => {
            if (cancelled) return;
            setProbing(false);
            if (result?.needsRelay && !relayAvailable() && !noAudioWarned.current.has(source.url)) {
                noAudioWarned.current.add(source.url);
                showToast(
                    'Esta opción necesita la retransmisión local para tener sonido. Enciéndela con: docker compose up -d',
                    6000,
                );
            }
            setProbeTick((t) => t + 1);
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [source?.url]);

    // ── Canal nuevo: ciclo desde cero ───────────────────────────────────
    useEffect(() => {
        clearRetry();
        attempts.current = 0;
        tried.current = new Set();
        setEngineOverride(null);
        setStatus('loading');
    }, [current?.id]);

    useEffect(() => {
        playedThisSource.current = false;
        recentFails.current = [];
    }, [source?.url, engine]);

    useEffect(() => {
        lastTime.current = null;
        lastProgressAt.current = Date.now();
        if (statusRef.current === 'playing') setStatus('loading');
    }, [source?.url, engine, playerKey]);

    useEffect(() => {
        if (!paused) lastProgressAt.current = Date.now();
    }, [paused]);

    // ── La opción está entregando video ─────────────────────────────────
    const markPlaying = useCallback(() => {
        lastProgressAt.current = Date.now();
        playedThisSource.current = true;
        if (statusRef.current !== 'playing') {
            clearRetry();
            attempts.current = 0;
            tried.current = new Set();
            setStatus('playing');
            const { current: ch, source: src, sourceIndex: idx, engine: eng } = live.current;
            if (ch) {
                console.log(`[BuriTV] Reproduciendo ${ch.name} · opción ${idx + 1} · ${eng}`);
                live.current.onSourceWorking?.(ch.id, idx, eng);
                live.current.onSourceResult?.(src?.url, true);
            }
        }
    }, []);

    const handleProgress = useCallback(
        (t) => {
            if (t != null && t !== lastTime.current) {
                lastTime.current = t;
                markPlaying();
            }
        },
        [markPlaying],
    );

    /**
     * Algo falló.
     *  reason: 'error' | 'stall' | 'timeout' | 'ended'
     *  info:   { dead } el servidor no responde (404, conexión rechazada…)
     *          { compat } el navegador no puede decodificar la señal
     */
    const fail = useCallback(
        (reason, info = {}) => {
            const { current: ch, source: src, sourceIndex: idx, selectSource: pick, paused: p, engine: eng } =
                live.current;
            if (!ch || !src || p) return;
            if (retryTimer.current) return;

            const count = ch.sources.length;
            live.current.onSourceResult?.(src.url, false);
            console.log(
                `[BuriTV] Fallo (${reason}${info.detail ? ` ${info.detail}` : ''}) en ${ch.name} · ` +
                    `opción ${idx + 1}/${count} · ${eng}`,
            );

            const now = Date.now();
            recentFails.current = recentFails.current.filter((t) => now - t < FLAP_WINDOW_MS);
            recentFails.current.push(now);
            const flapping = recentFails.current.length >= FLAP_LIMIT;

            if (playedThisSource.current && reason !== 'timeout' && !info.compat) {
                live.current.onStall?.();
            }
            if (reason === 'stall' && playedThisSource.current && eng === 'hls') {
                setBitrateCaps((prev) => {
                    const cur = prev[src.url];
                    const next = BITRATE_STEPS.find((b) => !cur || b < cur);
                    return next ? { ...prev, [src.url]: next } : prev;
                });
            }

            const canRelay = eng !== 'relay' && eng !== 'web' && relayAvailable();

            // 0) El navegador no decodifica esta señal → retransmisión ya
            if (info.compat && canRelay) {
                attempts.current = 0;
                setStatus('reconnecting');
                schedule(150, () =>
                    setEngineOverride({ url: src.url, engine: 'relay', relayVideo: info.relayVideo }),
                );
                return;
            }

            // 1) Microcorte: misma opción, mismo motor
            let maxRetries = 1;
            if (flapping || reason === 'timeout' || info.dead) maxRetries = 0;
            else if (playedThisSource.current) maxRetries = RETRY_BACKOFF_MS.length;
            if (attempts.current < maxRetries) {
                const wait = RETRY_BACKOFF_MS[Math.min(attempts.current, RETRY_BACKOFF_MS.length - 1)];
                attempts.current += 1;
                setStatus('reconnecting');
                schedule(wait, () => setPlayerKey((k) => k + 1));
                return;
            }

            // 2) El servidor responde pero el navegador no se lleva bien con
            //    la señal → la misma opción por la retransmisión
            if (canRelay && (!info.dead || flapping)) {
                attempts.current = 0;
                setStatus('reconnecting');
                schedule(300, () => setEngineOverride({ url: src.url, engine: 'relay' }));
                return;
            }

            // 3) Otra opción del mismo canal: la más estable que falte probar
            tried.current.add(idx);
            const order = live.current.rankSources?.(ch) ?? [...ch.sources.keys()];
            const nextOption = order.find((i) => !tried.current.has(i));
            if (nextOption != null) {
                attempts.current = 0;
                setStatus('reconnecting');
                schedule(300, () => pick(nextOption));
                return;
            }

            // 4) Ninguna opción responde
            setStatus('failed');
            schedule(FAILED_RETRY_MS, () => {
                attempts.current = 0;
                tried.current = new Set();
                setEngineOverride(null);
                setStatus('reconnecting');
                const best = (live.current.rankSources?.(ch) ?? [])[0] ?? (idx + 1) % count;
                if (best !== idx) pick(best);
                else setPlayerKey((k) => k + 1);
            });
        },
        [schedule],
    );

    // ── Watchdog ─────────────────────────────────────────────────────────
    useEffect(() => {
        const iv = setInterval(() => {
            const { current: ch, source: src, paused: p, probing: pr } = live.current;
            if (!ch || !src || p || pr || retryTimer.current) return;
            const st = statusRef.current;
            if (st === 'failed') return;
            if (st === 'playing' && src.type === 'web') return;
            const elapsed = Date.now() - lastProgressAt.current;
            const slow = live.current.slowMode;
            const limit =
                st === 'playing'
                    ? slow
                        ? STALL_MS_SLOW
                        : STALL_MS
                    : slow
                      ? START_TIMEOUT_MS_SLOW
                      : START_TIMEOUT_MS;
            if (elapsed > limit) fail(st === 'playing' ? 'stall' : 'timeout');
        }, WATCHDOG_MS);
        return () => clearInterval(iv);
    }, [fail]);

    const retry = useCallback(() => {
        clearRetry();
        attempts.current = 0;
        tried.current = new Set();
        setStatus('loading');
        setPlayerKey((k) => k + 1);
    }, []);

    const resetCycle = useCallback(() => {
        clearRetry();
        attempts.current = 0;
        tried.current = new Set();
        setEngineOverride(null);
        setStatus('loading');
    }, []);

    useEffect(() => clearRetry, []);

    return {
        status,
        engine,
        relayVideo,
        playerKey,
        maxBitRate,
        probing,
        probeTick,
        handleProgress,
        handlePlaying: markPlaying,
        fail,
        retry,
        resetCycle,
    };
}
