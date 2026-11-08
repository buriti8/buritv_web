import { useMemo, useState, useCallback } from 'react';
import { load, save } from '../lib/storage';

export const ALL = '__all__';
export const FAV = '__fav__';
export const LIVE = '__live__';
const K_CATEGORY = 'filterCategory';

const norm = (s) =>
    (s || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .trim();

/**
 * Búsqueda + categoría (group-title del M3U) + favoritos + "En vivo"
 * (canales que están dando un partido, según nowPlaying).
 * Ignora mayúsculas y tildes; un número busca también por número de canal.
 * La categoría elegida se recuerda.
 */
export default function useChannelFilter(channels, favorites, nowPlaying = {}) {
    const [query, setQuery] = useState('');
    const [category, setCategoryState] = useState(() => load(K_CATEGORY, ALL));

    const setCategory = useCallback((id) => {
        setCategoryState(id);
        save(K_CATEGORY, id);
    }, []);

    const favCount = useMemo(
        () => (favorites.size ? channels.filter((ch) => favorites.has(ch.id)).length : 0),
        [channels, favorites],
    );

    const liveCount = useMemo(
        () => channels.filter((ch) => nowPlaying[ch.id]?.state === 'live').length,
        [channels, nowPlaying],
    );

    const categories = useMemo(() => {
        const counts = new Map();
        channels.forEach((ch) => {
            if (ch.group) counts.set(ch.group, (counts.get(ch.group) || 0) + 1);
        });
        if (!counts.size && !favCount && !liveCount) return [];
        return [
            { id: ALL, label: 'Todos', count: channels.length },
            ...(liveCount ? [{ id: LIVE, label: 'En vivo', count: liveCount, live: true }] : []),
            ...(favCount ? [{ id: FAV, label: 'Favoritos', count: favCount, fav: true }] : []),
            ...[...counts].map(([g, n]) => ({ id: g, label: g, count: n })),
        ];
    }, [channels, favCount, liveCount]);

    const active = categories.some((c) => c.id === category) ? category : ALL;

    const items = useMemo(() => {
        const q = norm(query);
        const isNum = /^\d+$/.test(q);
        const out = [];
        channels.forEach((ch, index) => {
            if (active === FAV) {
                if (!favorites.has(ch.id)) return;
            } else if (active === LIVE) {
                if (nowPlaying[ch.id]?.state !== 'live') return;
            } else if (active !== ALL && ch.group !== active) return;
            if (q) {
                const byName = norm(ch.name).includes(q);
                const byNum = isNum && String(index + 1).startsWith(q);
                if (!byName && !byNum) return;
            }
            out.push({ ch, index });
        });
        return out;
    }, [channels, favorites, nowPlaying, query, active]);

    const filtering = !!query.trim() || active !== ALL;
    const clear = useCallback(() => {
        setQuery('');
        setCategory(ALL);
    }, [setCategory]);

    return { query, setQuery, category: active, setCategory, categories, items, filtering, clear };
}
