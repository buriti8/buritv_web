import { useEffect, useRef, useState } from 'react';
import { RECONNECT_GRACE_MS } from '../config';

/**
 * Estado del stream tal como se MUESTRA al usuario.
 *
 * Si la opción que ya estaba sonando se reconecta (microcorte, cambio a VLC,
 * salto al vivo…), durante RECONNECT_GRACE_MS se sigue mostrando como "en
 * vivo": nada de "Reconectando…" ni de quitar la etiqueta, solo un indicador
 * discreto (quiet). La mayoría de esas reconexiones terminan antes y el
 * usuario ni se entera. Si tarda más, se muestra el estado real.
 *
 * Al cambiar de canal o de opción (key distinta) el estado se muestra tal
 * cual: ahí "Conectando…" sí es información útil.
 *
 *  key: identifica canal + opción, p. ej. "espn|1"
 */
export default function useDisplayStatus(status, key) {
    const lastPlayingKey = useRef(null);
    const prevStatus = useRef(status);
    const interruption = useRef(0); // cuenta cada vez que se deja de reproducir
    const [expired, setExpired] = useState(-1); // interrupción que ya superó el margen

    if (status === 'playing') lastPlayingKey.current = key;
    if (prevStatus.current === 'playing' && status !== 'playing') interruption.current += 1;
    prevStatus.current = status;
    const token = interruption.current;

    const quiet =
        (status === 'loading' || status === 'reconnecting') &&
        lastPlayingKey.current === key &&
        expired !== token;

    useEffect(() => {
        if (!quiet) return;
        const t = setTimeout(() => setExpired(token), RECONNECT_GRACE_MS);
        return () => clearTimeout(t);
    }, [quiet, token]);

    return { displayStatus: quiet ? 'playing' : status, quiet };
}
