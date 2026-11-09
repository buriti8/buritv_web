import { useEffect, useMemo, useState } from 'react';
import { EPG_URLS, EPG_POLL_MS, EPG_TICK_MS } from '../config';

const EMPTY = {};

async function fetchEpg() {
    for (const url of EPG_URLS) {
        try {
            const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout?.(15000) });
            if (!res.ok) continue;
            const data = await res.json();
            if (data && typeof data.channels === 'object') return data.channels;
        } catch {}
    }
    return null;
}

/** Programa al aire y el siguiente de cada canal: { [channelId]: { now, next } }. */
function current(guide, at) {
    const out = {};
    for (const [id, list] of Object.entries(guide)) {
        const i = list.findIndex((p) => p.stop > at);
        if (i < 0) continue;
        const now = list[i].start <= at ? list[i] : null;
        const next = now ? list[i + 1] ?? null : list[i];
        if (now || next) out[id] = { now, next };
    }
    return out;
}

/**
 * Programación de cada canal según la guía (relay /epg). La guía se pide cada
 * EPG_POLL_MS (y al volver a la pestaña); "ahora / sigue" se recalcula cada
 * EPG_TICK_MS para pasar solo al programa siguiente cuando termina el actual.
 */
export default function useEpg() {
    const [guide, setGuide] = useState(EMPTY);
    const [at, setAt] = useState(() => Date.now());

    useEffect(() => {
        let timer = null;
        let alive = true;
        const poll = async () => {
            clearTimeout(timer);
            const channels = await fetchEpg();
            if (!alive) return;
            if (channels) setGuide(Object.keys(channels).length ? channels : EMPTY);
            if (!document.hidden) timer = setTimeout(poll, EPG_POLL_MS);
        };
        const onVisibility = () => {
            if (document.hidden) clearTimeout(timer);
            else {
                setAt(Date.now());
                poll();
            }
        };
        poll();
        const tick = setInterval(() => !document.hidden && setAt(Date.now()), EPG_TICK_MS);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            alive = false;
            clearTimeout(timer);
            clearInterval(tick);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, []);

    // Se redondea al minuto para no rehacer la lista (ni volver a pintar las filas) sin necesidad
    const minute = Math.floor(at / 60000);
    return useMemo(() => (guide === EMPTY ? EMPTY : current(guide, minute * 60000)), [guide, minute]);
}
