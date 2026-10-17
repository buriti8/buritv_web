import { useState, useCallback } from 'react';
import { load, save } from '../lib/storage';

const K_FAVORITES = 'favorites';

/** Canales favoritos (por id), guardados en el navegador. */
export default function useFavorites() {
    const [favorites, setFavorites] = useState(() => new Set(load(K_FAVORITES, [])));

    const toggleFavorite = useCallback((id) => {
        if (!id) return;
        setFavorites((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            save(K_FAVORITES, [...next]);
            return next;
        });
    }, []);

    return { favorites, toggleFavorite };
}
