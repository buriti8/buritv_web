import { RELAY_URL, STREAMS_URLS } from '../config';

/**
 * Streamers (Twitch, Kick, YouTube):
 *  - Twitch se reproduce por HLS a través del relay (/twitch/<canal>.m3u8):
 *    su reproductor embebido se pausa cuando no está visible y exige que la
 *    página sea HTTPS con su dominio en `parent`.
 *  - Los enlaces de YouTube a /@canal/live (o /channel/…/live) no se pueden
 *    embeber: se pasan al video en vivo del momento, que da /streams.
 */

/** Canal de Twitch de la URL, o null. */
export function twitchLogin(raw) {
    try {
        const u = new URL(raw);
        const host = u.hostname.replace(/^(www|m)\./, '');
        if (host === 'player.twitch.tv') {
            const c = u.searchParams.get('channel');
            return c && /^\w{2,25}$/.test(c) ? c.toLowerCase() : null;
        }
        if (host === 'twitch.tv') {
            const parts = u.pathname.split('/').filter(Boolean);
            return parts.length === 1 && /^\w{2,25}$/.test(parts[0]) ? parts[0].toLowerCase() : null;
        }
    } catch {}
    return null;
}

/** ¿Es la página "en vivo" de un canal de YouTube (sin id de video)? */
export function isYouTubeLivePage(raw) {
    try {
        const u = new URL(raw);
        if (!/(^|\.)youtube\.com$/.test(u.hostname)) return false;
        return /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/live\/?$/.test(u.pathname);
    } catch {
        return false;
    }
}

/** La opción tal como se reproduce: Twitch pasa a HLS por el relay. `page` = la URL original. */
export function playableSource(src) {
    const login = src.type === 'web' ? twitchLogin(src.url) : null;
    if (!login) return src;
    return { ...src, url: `${RELAY_URL}/twitch/${login}.m3u8`, type: 'stream', page: src.url };
}

/** Estado de los streamers en el relay: { updatedAt, channels, sources } o null. */
export async function fetchStreams() {
    for (const url of STREAMS_URLS) {
        try {
            const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout?.(15000) });
            if (!res.ok) continue;
            const data = await res.json();
            if (data && typeof data.channels === 'object') return data;
        } catch {}
    }
    return null;
}

/** Espectadores abreviados: 100, 1.5k, 15k, 1.2M */
export function fmtViewers(n) {
    if (n < 1000) return String(n);
    const [div, unit] = n < 1e6 ? [1e3, 'k'] : [1e6, 'M'];
    const v = n / div;
    // Un decimal solo por debajo de 10 (1.5k, pero 15k)
    const r = v < 10 ? Math.floor(v * 10) / 10 : Math.floor(v);
    return `${r}${unit}`;
}

/** Texto para la lista: "36k · Jugando GTA…" / "Offline". */
export function streamText(s) {
    if (!s) return null;
    if (!s.live) return 'Offline';
    return [s.viewers != null && fmtViewers(s.viewers), s.title || 'En vivo'].filter(Boolean).join(' · ');
}

const PLATFORM_NAMES = { twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube' };

/** Para el title: el mismo texto completo, debajo la categoría y, si es multistream, el detalle. */
export function streamTitle(s) {
    if (!s) return undefined;
    const multi =
        s.live && s.multi?.length > 1
            ? s.multi
                  .map((m) => `${PLATFORM_NAMES[m.platform] || m.platform}: ${m.viewers != null ? fmtViewers(m.viewers) : '?'}`)
                  .join(' + ')
            : null;
    return [streamText(s), s.live && s.game, multi].filter(Boolean).join('\n');
}
