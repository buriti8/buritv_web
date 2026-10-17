import { useCallback, useEffect, useState } from 'react';
import { loadCast } from '../lib/cast';
import { prepareCastUrl } from '../lib/relay';
import { showToast } from '../lib/toast';

const deviceName = (ctx) => ctx.getCurrentSession()?.getCastDevice()?.friendlyName || 'Chromecast';

/**
 * Transmite al Chromecast la señal que se está viendo.
 *  - Pasa por la retransmisión (audio AAC / video H.264); sin ella se envía la
 *    señal directa, que casi siempre queda sin audio.
 *  - Al cambiar de canal u opción mientras se transmite, se actualiza (con una
 *    pausa: al pasar rápido por varios no se prepara cada uno).
 *  - Las páginas web (iframe) no se pueden transmitir.
 */
export default function useCast({ source, channel, castable }) {
    const [available, setAvailable] = useState(false);
    const [device, setDevice] = useState(null); // nombre del Chromecast, o null

    useEffect(() => {
        let off = () => {};
        let alive = true;
        loadCast().then((ok) => {
            if (!alive || !ok) return;
            setAvailable(true);
            const ctx = cast.framework.CastContext.getInstance();
            const T = cast.framework.SessionState;
            const EVENT = cast.framework.CastContextEventType.SESSION_STATE_CHANGED;
            const on = (e) => {
                if (e.sessionState === T.SESSION_STARTED || e.sessionState === T.SESSION_RESUMED) {
                    setDevice(deviceName(ctx));
                } else if (e.sessionState === T.SESSION_ENDED) setDevice(null);
            };
            ctx.addEventListener(EVENT, on);
            if (ctx.getCurrentSession()) setDevice(deviceName(ctx));
            off = () => ctx.removeEventListener(EVENT, on);
        });
        return () => {
            alive = false;
            off();
        };
    }, []);

    const start = useCallback(() => {
        // Abre el selector de dispositivos; se rechaza si se cancela
        cast.framework.CastContext.getInstance()
            .requestSession()
            .catch(() => {});
    }, []);

    const stop = useCallback(() => {
        cast.framework.CastContext.getInstance().endCurrentSession(true);
    }, []);

    const url = source?.url;
    const name = channel?.name;
    useEffect(() => {
        if (!device || !url) return;
        if (!castable) {
            showToast('Esta señal es una página web: no se puede enviar a Chromecast');
            return;
        }
        let cancelled = false;
        const timer = setTimeout(async () => {
            showToast('Preparando la señal para Chromecast…', 8000);
            const prepared = await prepareCastUrl(url);
            if (cancelled) return;
            if (!prepared) {
                showToast('Sin la retransmisión se envía la señal directa (puede no tener audio)', 4000);
            }
            const hls = !!prepared || /\.m3u8(\?|$)/i.test(url);
            const info = new chrome.cast.media.MediaInfo(
                prepared || url,
                hls ? 'application/x-mpegURL' : 'video/mp2t',
            );
            info.streamType = chrome.cast.media.StreamType.LIVE;
            info.metadata = new chrome.cast.media.GenericMediaMetadata();
            info.metadata.title = name;
            if (hls && chrome.cast.media.HlsVideoSegmentFormat) {
                info.hlsVideoSegmentFormat = chrome.cast.media.HlsVideoSegmentFormat.MPEG2_TS;
            }
            const request = new chrome.cast.media.LoadRequest(info);
            request.autoplay = true;
            const session = cast.framework.CastContext.getInstance().getCurrentSession();
            if (!session) return;
            try {
                const error = await session.loadMedia(request);
                if (error) showToast('El Chromecast no pudo reproducir esta señal. Prueba otra opción.', 4000);
            } catch {
                showToast('No se pudo enviar al Chromecast');
            }
        }, 600);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [device, url, name, castable]);

    return { available, casting: !!device, device, start, stop };
}
