import { useEffect, useState } from 'react';
import { STREAMS_POLL_MS } from '../config';
import { fetchStreams } from '../lib/streamers';

const EMPTY = { channels: {}, sources: {} };
const STALE_MS = 3 * 60 * 1000;
const RETRY_MS = 5000;
const MAX_RETRIES = 3;

/**
 * Streamers en vivo y su título: { channels: { [channelId]: estado }, sources: { [url]: estado } }.
 * Se consulta cada STREAMS_POLL_MS mientras la pestaña está visible y al
 * volver a ella. Si falla, se deja lo último que se tenía.
 */
export default function useStreams() {
    const [streams, setStreams] = useState(EMPTY);

    useEffect(() => {
        let timer = null;
        let alive = true;
        let retries = 0; // reintentos rápidos seguidos (si el relay falla, no insistir)
        const tick = async () => {
            clearTimeout(timer);
            const data = await fetchStreams();
            if (!alive) return;
            if (data) setStreams({ channels: data.channels || {}, sources: data.sources || {} });
            // Dato viejo (el relay aún estaba consultando): se vuelve a pedir pronto
            const stale = !data || Date.now() - (data.updatedAt || 0) > STALE_MS;
            retries = stale ? retries + 1 : 0;
            const fast = stale && retries <= MAX_RETRIES;
            if (!document.hidden) timer = setTimeout(tick, fast ? RETRY_MS : STREAMS_POLL_MS);
        };
        const onVisibility = () => {
            if (document.hidden) clearTimeout(timer);
            else {
                retries = 0;
                tick();
            }
        };
        tick();
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            alive = false;
            clearTimeout(timer);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, []);

    return streams;
}
