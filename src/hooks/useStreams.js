import { useEffect, useState } from 'react';
import { STREAMS_POLL_MS } from '../config';
import { fetchStreams } from '../lib/streamers';

const EMPTY = { channels: {}, sources: {} };

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
        const tick = async () => {
            clearTimeout(timer);
            const data = await fetchStreams();
            if (!alive) return;
            if (data) setStreams({ channels: data.channels || {}, sources: data.sources || {} });
            if (!document.hidden) timer = setTimeout(tick, STREAMS_POLL_MS);
        };
        const onVisibility = () => {
            if (document.hidden) clearTimeout(timer);
            else tick();
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
