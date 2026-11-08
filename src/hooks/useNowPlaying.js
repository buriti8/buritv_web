import { useEffect, useState } from 'react';
import { NOW_PLAYING_URLS, NOW_PLAYING_POLL_MS } from '../config';

const EMPTY = {};

async function fetchNowPlaying() {
    for (const url of NOW_PLAYING_URLS) {
        try {
            const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout?.(10000) });
            if (!res.ok) continue;
            const data = await res.json();
            if (data && typeof data.channels === 'object') return data.channels;
        } catch {}
    }
    return null;
}

/**
 * Partido que está dando cada canal ahora: { [channelId]: partido }.
 * Se consulta cada NOW_PLAYING_POLL_MS mientras la pestaña está visible y
 * al volver a ella. Si falla, se deja lo último que se tenía.
 */
export default function useNowPlaying() {
    const [byChannel, setByChannel] = useState(EMPTY);

    useEffect(() => {
        let timer = null;
        let alive = true;
        const tick = async () => {
            clearTimeout(timer);
            const channels = await fetchNowPlaying();
            if (!alive) return;
            if (channels) setByChannel(Object.keys(channels).length ? channels : EMPTY);
            if (!document.hidden) timer = setTimeout(tick, NOW_PLAYING_POLL_MS);
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

    return byChannel;
}
