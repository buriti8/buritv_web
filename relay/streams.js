/**
 * BuriTV · streamers (Twitch, Kick, YouTube): si están en vivo y con qué título
 *
 *  - Los canales salen de la propia lista M3U: toda opción cuya URL sea de
 *    Twitch, Kick o YouTube se consulta.
 *  - Twitch: API GraphQL pública de su web (todos los canales en una petición).
 *    Kick: su API de canales. YouTube: la página /live del canal (o del video).
 *  - Bajo demanda, como /now-playing: se consulta cuando alguien pide /streams
 *    y lo que se tiene tiene más de TTL_MS (YouTube, YT_TTL_MS: su página pesa).
 *    Si una consulta falla, se conserva lo último que dio.
 *
 * GET /streams → { updatedAt,
 *                  channels: { <tvg-id>: estado },   (en vivo si alguna opción lo está)
 *                  sources:  { <url de la opción>: estado } }
 *   estado = { platform, live, title, viewers?, game?, videoId? }
 *   (videoId: el video en vivo de YouTube, para embeberlo)
 *
 * GET /twitch/<canal>.m3u8 → la lista HLS de Twitch (con un permiso nuevo cada
 *   vez, como reproductor "embed": así no trae el anuncio inicial; las calidades
 *   y los segmentos sí se dejan pedir desde la web).
 */
import { requestJson, requestText } from './http.js';

const TTL_MS = 60 * 1000;
const YT_TTL_MS = 2 * 60 * 1000;
const RETRY_MS = 60 * 1000;
// Client-ID público de la web de Twitch (el que usan streamlink, yt-dlp…)
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const TWITCH_GQL = 'https://gql.twitch.tv/gql';

// ── Qué streamer es cada URL ──

/** { platform, handle } o null */
export function parseStreamUrl(raw) {
    let u;
    try {
        u = new URL(raw);
    } catch {
        return null;
    }
    const host = u.hostname.replace(/^(www|m)\./, '');
    const parts = u.pathname.split('/').filter(Boolean);
    if (host === 'player.twitch.tv') {
        const c = u.searchParams.get('channel');
        return c && /^\w{2,25}$/.test(c) ? { platform: 'twitch', handle: c.toLowerCase() } : null;
    }
    if (host === 'twitch.tv') {
        return parts[0] && /^\w{2,25}$/.test(parts[0]) && parts.length === 1
            ? { platform: 'twitch', handle: parts[0].toLowerCase() }
            : null;
    }
    if (host === 'player.kick.com' || host === 'kick.com') {
        return parts[0] && /^[\w-]{2,40}$/.test(parts[0]) ? { platform: 'kick', handle: parts[0].toLowerCase() } : null;
    }
    if (host === 'youtube.com' || host === 'youtu.be') {
        // /@canal/live, /channel/UC…/live, /c/x/live, /watch?v=…, youtu.be/…, /embed/…, /live/…
        if (host === 'youtu.be' && parts[0]) return { platform: 'youtube', handle: `v:${parts[0]}` };
        if (parts[0] === 'watch' && u.searchParams.get('v')) return { platform: 'youtube', handle: `v:${u.searchParams.get('v')}` };
        if ((parts[0] === 'embed' || parts[0] === 'live') && parts[1] && parts[1] !== 'live_stream')
            return { platform: 'youtube', handle: `v:${parts[1]}` };
        if (parts[0]?.startsWith('@')) return { platform: 'youtube', handle: parts[0] };
        if ((parts[0] === 'channel' || parts[0] === 'c' || parts[0] === 'user') && parts[1])
            return { platform: 'youtube', handle: `${parts[0]}/${parts[1]}` };
    }
    return null;
}

/** [{ tvgId, url, platform, handle }] de la lista */
function streamersOf(m3u) {
    const out = [];
    let tvgId = null;
    for (const raw of m3u.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('#EXTINF')) tvgId = (/tvg-id="([^"]*)"/i.exec(line) || [])[1] || null;
        else if (line && !line.startsWith('#')) {
            const s = parseStreamUrl(line);
            if (s && tvgId) out.push({ tvgId, url: line, ...s });
            tvgId = null;
        }
    }
    return out;
}

// ── Consultas ──

async function twitchGql(body) {
    return requestJson(TWITCH_GQL, {
        method: 'POST',
        headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeout: 15000,
    });
}

/** { login: estado } de varios canales en una sola consulta */
async function fetchTwitch(logins) {
    const fields = logins
        .map((l, i) => `u${i}: user(login: "${l}") { stream { title type viewersCount game { name } } broadcastSettings { title } }`)
        .join(' ');
    const res = await twitchGql({ query: `query { ${fields} }` });
    if (!res?.data) throw new Error('respuesta inesperada');
    const out = {};
    logins.forEach((l, i) => {
        const user = res.data[`u${i}`];
        const st = user?.stream;
        const live = !!st && st.type === 'live';
        out[l] = {
            platform: 'twitch',
            live,
            title: (st?.title || user?.broadcastSettings?.title || '').trim() || null,
            viewers: live ? st.viewersCount ?? null : null,
            game: live ? st.game?.name ?? null : null,
        };
    });
    return out;
}

async function fetchKick(slug) {
    const d = await requestJson(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
        headers: { Accept: 'application/json' },
        timeout: 15000,
    });
    const ls = d?.livestream;
    const live = !!ls?.is_live;
    return {
        platform: 'kick',
        live,
        title: (ls?.session_title || '').trim() || null,
        viewers: live ? ls.viewer_count ?? null : null,
        game: live ? ls.categories?.[0]?.name ?? null : null,
    };
}

const htmlUnescape = (s) =>
    s
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');

async function fetchYouTube(handle) {
    const url = handle.startsWith('v:')
        ? `https://www.youtube.com/watch?v=${encodeURIComponent(handle.slice(2))}`
        : `https://www.youtube.com/${handle}/live`;
    const html = await requestText(url, {
        headers: { 'Accept-Language': 'es-419,es;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' },
        timeout: 20000,
    });
    // Si el canal no está en vivo, /live lleva a la página del canal (sin video)
    const videoId =
        (/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/.exec(html) || [])[1] || null;
    const live = !!videoId && /"isLiveNow":true/.test(html);
    // Sin directo, el video que aparece es uno viejo o programado: su título confundiría
    const title = live ? htmlUnescape((/<meta name="title" content="([^"]*)"/.exec(html) || [])[1] || '').trim() : '';
    const viewers = live ? Number((/"originalViewCount":"(\d+)"/.exec(html) || [])[1]) || null : null;
    return { platform: 'youtube', live, title: title || null, viewers, videoId: live ? videoId : null };
}

// ── Caché por streamer ("twitch:kaicenat") ──

const cache = new Map(); // clave → { at, data }
const fresh = (key, ttl) => {
    const c = cache.get(key);
    return c && Date.now() - c.at < ttl;
};
const failed = (key, ttl) => cache.set(key, { at: Date.now() - ttl + RETRY_MS, data: cache.get(key)?.data });
const ttlOf = (platform) => (platform === 'youtube' ? YT_TTL_MS : TTL_MS);

async function ensure(list) {
    const jobs = [];
    const logins = [...new Set(list.filter((s) => s.platform === 'twitch').map((s) => s.handle))].filter(
        (h) => !fresh(`twitch:${h}`, TTL_MS),
    );
    if (logins.length)
        jobs.push(
            fetchTwitch(logins)
                .then((byLogin) => logins.forEach((h) => cache.set(`twitch:${h}`, { at: Date.now(), data: byLogin[h] })))
                .catch((e) => {
                    console.log(`[streams] twitch: ${e.message}`);
                    logins.forEach((h) => failed(`twitch:${h}`, TTL_MS));
                }),
        );
    const single = { kick: fetchKick, youtube: fetchYouTube };
    const seen = new Set();
    for (const s of list) {
        const key = `${s.platform}:${s.handle}`;
        if (!single[s.platform] || seen.has(key) || fresh(key, ttlOf(s.platform))) continue;
        seen.add(key);
        jobs.push(
            single[s.platform](s.handle)
                .then((data) => cache.set(key, { at: Date.now(), data }))
                .catch((e) => {
                    console.log(`[streams] ${key}: ${e.message}`);
                    failed(key, ttlOf(s.platform));
                }),
        );
    }
    await Promise.all(jobs);
}

// ── Armado ──

let state = { updatedAt: 0, channels: {}, sources: {} };
let loading = null;

async function refresh(loadM3u) {
    const m3u = await loadM3u();
    if (!m3u) throw new Error('sin lista');
    const list = streamersOf(m3u);
    await ensure(list);
    const channels = {};
    const sources = {};
    for (const s of list) {
        const data = cache.get(`${s.platform}:${s.handle}`)?.data;
        if (!data) continue;
        sources[s.url] = data;
        // El canal: la primera opción en vivo; si ninguna, la primera
        if (!channels[s.tvgId] || (data.live && !channels[s.tvgId].live)) channels[s.tvgId] = data;
    }
    state = { updatedAt: Date.now(), channels, sources };
}

/** Estado de los streamers de la lista. `loadM3u` → texto de la lista (o null). */
export async function getStreams(loadM3u) {
    if (Date.now() - state.updatedAt >= TTL_MS) {
        loading ||= refresh(loadM3u)
            .catch((e) => console.log(`[streams] ${e.message}`))
            .finally(() => {
                loading = null;
            });
        // La primera vez se espera; después se responde con lo que hay
        if (!state.updatedAt) await loading;
    }
    return state;
}

// ── Twitch HLS ──

const PLAYBACK_QUERY =
    'query PlaybackAccessToken($login: String!) { streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: "embed"}) { value signature } }';

/** Lista HLS principal del canal, o null si no está en vivo. */
export async function getTwitchPlaylist(login) {
    if (!/^\w{2,25}$/.test(login)) return null;
    const res = await twitchGql({ query: PLAYBACK_QUERY, variables: { login: login.toLowerCase() } });
    const tok = res?.data?.streamPlaybackAccessToken;
    if (!tok?.value) return null;
    const params = new URLSearchParams({
        sig: tok.signature,
        token: tok.value,
        allow_source: 'true',
        allow_audio_only: 'true',
        playlist_include_framerate: 'true',
        player_backend: 'mediaplayer',
        // Solo H.264: el navegador no siempre decodifica HEVC/AV1
        supported_codecs: 'avc1',
        p: String(Math.floor(Math.random() * 1e7)),
    });
    try {
        const text = await requestText(`https://usher.ttvnw.net/api/channel/hls/${login.toLowerCase()}.m3u8?${params}`, {
            timeout: 15000,
        });
        return text.includes('#EXTM3U') ? text : null;
    } catch (e) {
        // 404: el canal no está transmitiendo
        if (e.status === 404 || e.status === 403) return null;
        throw e;
    }
}
