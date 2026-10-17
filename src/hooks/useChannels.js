import { useState, useCallback, useRef, useEffect } from 'react';
import { M3U_URLS, M3U_TIMEOUT_MS, M3U_RETRY_MS } from '../config';
import parseM3U from '../lib/parseM3U';
import { load, save } from '../lib/storage';

const K_LAST_CHANNEL = 'lastChannelId';
const K_SOURCE_PREFS = 'sourcePrefs';
const K_M3U_CACHE = 'm3uCache';
const K_ENGINE_PREFS = 'enginePrefs';
const K_SOURCE_STATS = 'sourceStats';

// Historial de estabilidad por opción: cada resultado nuevo pesa más que los viejos
const STATS_DECAY = 0.85;
// Probabilidad estimada de que la opción funcione (0..1, 0.5 sin datos)
const scoreOf = (st) => (st ? (st.ok + 1) / (st.ok + st.fail + 2) : 0.5);

async function fetchText(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } finally {
        clearTimeout(timer);
    }
}

// Debe ser una lista M3U de verdad (no una página de error ni código fuente)
const isM3U = (text) => typeof text === 'string' && /^\s*#EXTM3U/.test(text) && text.includes('#EXTINF');

async function downloadList() {
    let lastError;
    for (const url of M3U_URLS) {
        try {
            const text = await fetchText(url, M3U_TIMEOUT_MS);
            // Debe ser una lista M3U de verdad (no una página de error o código)
            if (isM3U(text)) return text;
            lastError = new Error('Respuesta sin canales');
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError;
}

/**
 * Lista de canales, canal y opción actuales (igual que en la app):
 *  - La lista guardada se muestra al instante y se refresca de la red.
 *  - Se recuerda la última opción de cada canal y se sigue en ella al volver.
 *  - Cada opción lleva su historial de estabilidad: decide el orden en que
 *    se prueban las demás si la actual falla (rankSources).
 *  - Por opción se recuerda el motor que funcionó (hls / ts / relay).
 */
export default function useChannels() {
    const [channels, setChannels] = useState([]);
    const [current, setCurrent] = useState(null);
    const [sourceIndex, setSourceIndex] = useState(0);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState(null);
    const retryTimer = useRef(null);
    const retryCount = useRef(0);
    const hasList = useRef(false);

    const sourcePrefs = useRef(load(K_SOURCE_PREFS, {}));
    const enginePrefs = useRef(load(K_ENGINE_PREFS, {}));
    const sourceStats = useRef(load(K_SOURCE_STATS, {}));
    const statsSaveTimer = useRef(null);
    const currentRef = useRef(null);
    currentRef.current = current;

    const currentIndex = current ? channels.findIndex((ch) => ch.id === current.id) : -1;
    const source = current?.sources[sourceIndex] || current?.sources[0] || null;

    /** Primero la última opción usada en el canal; luego, de la más a la menos estable. */
    const rankSources = useCallback((ch) => {
        if (!ch) return [];
        const pref = sourcePrefs.current[ch.id];
        const hasPref = Number.isInteger(pref) && pref >= 0 && pref < ch.sources.length;
        const rest = ch.sources
            .map((s, i) => ({ i, score: scoreOf(sourceStats.current[s.url]) }))
            .filter((r) => !hasPref || r.i !== pref)
            .sort((a, b) => b.score - a.score || a.i - b.i)
            .map((r) => r.i);
        return hasPref ? [pref, ...rest] : rest;
    }, []);

    const recordSourceResult = useCallback((url, ok) => {
        if (!url) return;
        const prev = sourceStats.current[url] ?? { ok: 0, fail: 0 };
        sourceStats.current = {
            ...sourceStats.current,
            [url]: {
                ok: prev.ok * STATS_DECAY + (ok ? 1 : 0),
                fail: prev.fail * STATS_DECAY + (ok ? 0 : 1),
            },
        };
        clearTimeout(statsSaveTimer.current);
        statsSaveTimer.current = setTimeout(() => save(K_SOURCE_STATS, sourceStats.current), 2000);
    }, []);

    const saveSourcePref = useCallback((channelId, index) => {
        if (sourcePrefs.current[channelId] === index) return;
        sourcePrefs.current = { ...sourcePrefs.current, [channelId]: index };
        save(K_SOURCE_PREFS, sourcePrefs.current);
    }, []);

    const selectChannel = useCallback(
        (ch) => {
            if (!ch) return;
            setCurrent(ch);
            setSourceIndex(rankSources(ch)[0] ?? 0);
            save(K_LAST_CHANNEL, ch.id);
        },
        [rankSources],
    );

    // La usa la recuperación del stream para pasar a otra opción
    const selectSource = useCallback((i) => setSourceIndex(i), []);

    // Elegida por el usuario: se recuerda ya, aunque todavía no haya arrancado
    const chooseSource = useCallback(
        (i) => {
            setSourceIndex(i);
            const ch = currentRef.current;
            if (ch) saveSourcePref(ch.id, i);
        },
        [saveSourcePref],
    );

    // La opción reprodujo → se recuerda (y su motor)
    const rememberSource = useCallback(
        (channelId, index, engine) => {
            saveSourcePref(channelId, index);
            const url = currentRef.current?.sources[index]?.url;
            if (url && engine !== 'web' && enginePrefs.current[url] !== engine) {
                enginePrefs.current = { ...enginePrefs.current, [url]: engine };
                save(K_ENGINE_PREFS, enginePrefs.current);
            }
        },
        [saveSourcePref],
    );

    const getEnginePref = useCallback((url) => enginePrefs.current[url], []);

    const applyList = useCallback(
        (text) => {
            const { channels: parsed } = parseM3U(text);
            if (!parsed.length) return false;
            // ¿Primera carga? Se mira antes de fijar el canal
            const firstLoad = !currentRef.current;
            setChannels(parsed);
            hasList.current = true;
            const keepId = currentRef.current?.id ?? load(K_LAST_CHANNEL);
            const keep = keepId && parsed.find((ch) => ch.id === keepId);
            if (keep) {
                setCurrent(keep);
                currentRef.current = keep;
                if (firstLoad) setSourceIndex(rankSources(keep)[0] ?? 0);
            } else {
                setCurrent(parsed[0]);
                currentRef.current = parsed[0];
                setSourceIndex(0);
            }
            return true;
        },
        [rankSources],
    );

    const loadM3U = useCallback(async () => {
        clearTimeout(retryTimer.current);
        setLoadError(null);
        // Copia guardada (descartar si no es una lista válida)
        const saved = load(K_M3U_CACHE);
        const cached = isM3U(saved) ? saved : null;
        if (cached && applyList(cached)) setLoading(false);
        try {
            const text = await downloadList();
            retryCount.current = 0;
            if (text !== cached && applyList(text)) save(K_M3U_CACHE, text);
            setLoading(false);
        } catch {
            if (hasList.current) {
                setLoading(false);
                return;
            }
            const wait = M3U_RETRY_MS[Math.min(retryCount.current, M3U_RETRY_MS.length - 1)];
            retryCount.current += 1;
            setLoadError({ message: 'No pudimos cargar los canales. Revisa tu conexión.', retryIn: wait });
            retryTimer.current = setTimeout(() => loadM3U(), wait);
        }
    }, [applyList]);

    const retryLoad = useCallback(() => {
        retryCount.current = 0;
        loadM3U();
    }, [loadM3U]);

    useEffect(
        () => () => {
            clearTimeout(retryTimer.current);
            if (statsSaveTimer.current) save(K_SOURCE_STATS, sourceStats.current);
        },
        [],
    );

    return {
        channels,
        current,
        currentIndex,
        source,
        sourceIndex,
        loading,
        loadError,
        retryLoad,
        selectChannel,
        selectSource,
        chooseSource,
        rememberSource,
        rankSources,
        recordSourceResult,
        getEnginePref,
        loadM3U,
    };
}
