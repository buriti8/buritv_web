import { RELAY_URL } from '../config';

/**
 * Retransmisión local (relay/server.js). Si no está encendida, las señales
 * que la necesitan se tratan como caídas y la app pasa a otra opción.
 */
let available = null; // null = sin revisar
let checking = null;

export function relayAvailable() {
    return available === true;
}

/**
 * Página en HTTPS y señal en HTTP: el navegador la bloquea (contenido mixto),
 * así que solo se puede ver pasándola por la retransmisión.
 */
export function blockedAsMixed(url) {
    return window.location.protocol === 'https:' && /^http:/i.test(url);
}

/** Revisa (una vez, y de nuevo cada minuto si estaba apagada) si responde. */
export function checkRelay() {
    if (checking) return checking;
    checking = fetch(`${RELAY_URL}/health`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((j) => {
            available = !!(j.ok && j.ffmpeg);
        })
        .catch(() => {
            available = false;
        })
        .finally(() => {
            setTimeout(() => {
                checking = null;
            }, available ? 5 * 60000 : 60000);
        });
    return checking;
}

/** La página web servida por la retransmisión, con su audio bajo control de BuriTV. */
export function relayPageUrl(src, muted, volume) {
    return `${RELAY_URL}/page?url=${encodeURIComponent(src)}&m=${muted ? 1 : 0}&v=${volume}`;
}

/** URL HLS retransmitida (audio a AAC; video a H.264 si hace falta). */
export function relayHlsUrl(src, video = 'copy') {
    return `${RELAY_URL}/hls?src=${encodeURIComponent(src)}&video=${video}`;
}

/**
 * ¿La página se deja mostrar dentro de un iframe? Lo pregunta a la
 * retransmisión (el navegador no puede leer esas cabeceras). Sin
 * retransmisión se asume que sí.
 */
const frameCache = new Map();
export async function canEmbed(url) {
    if (frameCache.has(url)) return frameCache.get(url);
    if (!relayAvailable()) return true;
    try {
        const r = await fetch(`${RELAY_URL}/frame-check?url=${encodeURIComponent(url)}`);
        const j = await r.json();
        frameCache.set(url, j.embeddable !== false);
    } catch {
        frameCache.set(url, true);
    }
    return frameCache.get(url);
}

/**
 * Chromecast: pide a la retransmisión que prepare la señal (audio AAC, video
 * H.264: casi todas traen MP2, que el Chromecast no reproduce) y devuelve su
 * dirección en la red local. null si la retransmisión no está disponible.
 */
export async function prepareCastUrl(src, timeoutMs = 40000) {
    if (!relayAvailable()) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const r = await fetch(`${RELAY_URL}/cast?src=${encodeURIComponent(src)}`, { signal: ctrl.signal });
        const j = await r.json();
        return r.ok && j.url ? j.url : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
