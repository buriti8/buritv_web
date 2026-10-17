import { load, save } from './storage';

/**
 * ¿El navegador puede reproducir esta señal tal cual?
 *
 * Lee el comienzo del primer segmento (MPEG-TS) y mira qué códecs trae en
 * su tabla de programas (PAT/PMT). Los navegadores reproducen H.264 + AAC
 * (y MP3), pero no audio MP2/AC-3 ni video MPEG-2: esas señales se mandan
 * por la retransmisión local, que convierte el audio a AAC (y el video a
 * H.264 si hace falta).
 *
 * Se hace una sola vez por enlace: el resultado queda guardado en el equipo.
 */
const CACHE_KEY = 'codecs';
const PROBE_BYTES = 400000;
const PROBE_TIMEOUT_MS = 8000;
// Volver a revisar un enlace pasado este tiempo (el canal puede cambiar de códec)
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

const VIDEO = { 0x1b: 'h264', 0x24: 'hevc', 0x02: 'mpeg2', 0x01: 'mpeg1' };
const AUDIO = { 0x0f: 'aac', 0x11: 'aac', 0x81: 'ac3', 0x87: 'eac3' };
const LAYERS = [null, 'mp3', 'mp2', 'mp1'];

let cache = load(CACHE_KEY, {});

/** Lo que dice el historial para este enlace (o null si nunca se revisó). */
export function cachedProbe(url) {
    const c = cache[url];
    return c && Date.now() - c.at < CACHE_TTL_MS ? c : null;
}

function remember(url, result) {
    cache = { ...cache, [url]: { ...result, at: Date.now() } };
    save(CACHE_KEY, cache);
}

/** Decide si hace falta la retransmisión a partir de los códecs. */
function verdict(codecs) {
    const badAudio = ['mp2', 'mp1', 'ac3', 'eac3'].includes(codecs.audio);
    const badVideo = ['mpeg2', 'mpeg1', 'hevc'].includes(codecs.video);
    return {
        ...codecs,
        needsRelay: badAudio || badVideo,
        relayVideo: badVideo ? 'h264' : 'copy',
    };
}

async function fetchBytes(url, max, signal) {
    const res = await fetch(url, { signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks = [];
    let n = 0;
    while (n < max) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        n += value.length;
    }
    reader.cancel().catch(() => {});
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) {
        out.set(c.subarray(0, Math.min(c.length, n - o)), o);
        o += c.length;
        if (o >= n) break;
    }
    return { bytes: out, type: res.headers.get('content-type') || '' };
}

const firstUri = (text) => text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));

/** Analiza PAT/PMT y el primer frame de audio MPEG para saber la capa (MP2/MP3). */
export function parseTs(buf) {
    const pmtPids = new Set();
    const streams = {};
    const mpegAudioPids = {};
    let off = buf.indexOf(0x47);
    for (; off >= 0 && off + 188 <= buf.length; off += 188) {
        if (buf[off] !== 0x47) {
            const next = buf.indexOf(0x47, off + 1);
            if (next < 0) break;
            off = next - 188;
            continue;
        }
        const pusi = buf[off + 1] & 0x40;
        const pid = ((buf[off + 1] & 0x1f) << 8) | buf[off + 2];
        const afc = (buf[off + 3] >> 4) & 3;
        let p = off + 4;
        if (afc & 2) p += 1 + buf[p];
        if (!(afc & 1) || p >= off + 188) continue;

        if (pid === 0 && pusi) {
            p += 1 + buf[p];
            const len = ((buf[p + 1] & 0xf) << 8) | buf[p + 2];
            for (let i = p + 8; i < p + 3 + len - 4; i += 4) {
                const prog = (buf[i] << 8) | buf[i + 1];
                if (prog) pmtPids.add(((buf[i + 2] & 0x1f) << 8) | buf[i + 3]);
            }
        } else if (pmtPids.has(pid) && pusi) {
            p += 1 + buf[p];
            const len = ((buf[p + 1] & 0xf) << 8) | buf[p + 2];
            const pil = ((buf[p + 10] & 0xf) << 8) | buf[p + 11];
            let i = p + 12 + pil;
            const end = p + 3 + len - 4;
            while (i < end) {
                const st = buf[i];
                const epid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
                const eil = ((buf[i + 3] & 0xf) << 8) | buf[i + 4];
                streams[epid] = st;
                if (st === 3 || st === 4) mpegAudioPids[epid] = null;
                i += 5 + eil;
            }
        } else if (pid in mpegAudioPids && mpegAudioPids[pid] === null && pusi) {
            const q = p + 9 + buf[p + 8];
            for (let k = q; k < off + 187; k++) {
                if (buf[k] === 0xff && (buf[k + 1] & 0xe0) === 0xe0) {
                    mpegAudioPids[pid] = LAYERS[(buf[k + 1] >> 1) & 3];
                    break;
                }
            }
        }
    }
    let video = null;
    let audio = null;
    for (const [pid, st] of Object.entries(streams)) {
        if (!video && VIDEO[st]) video = VIDEO[st];
        if (!audio) {
            if (AUDIO[st]) audio = AUDIO[st];
            else if (st === 3 || st === 4) audio = mpegAudioPids[pid] || 'mp2';
        }
    }
    return { video, audio, ok: !!(video || audio) };
}

/**
 * Revisa el enlace (HLS o TS directo). Devuelve { needsRelay, relayVideo,
 * audio, video } o null si no se pudo saber (se reproduce directo y listo).
 */
export async function probe(url) {
    const hit = cachedProbe(url);
    if (hit) return hit;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
        let segUrl = url;
        if (/\.m3u8?(\?|$)/i.test(url)) {
            let base = url;
            let text = await (await fetch(url, { signal: ctrl.signal, cache: 'no-store' })).text();
            if (text.includes('#EXT-X-STREAM-INF')) {
                base = new URL(firstUri(text), url).toString();
                text = await (await fetch(base, { signal: ctrl.signal, cache: 'no-store' })).text();
            }
            const seg = firstUri(text);
            if (!seg) return null;
            segUrl = new URL(seg, base).toString();
        }
        const { bytes } = await fetchBytes(segUrl, PROBE_BYTES, ctrl.signal);
        const codecs = parseTs(bytes);
        if (!codecs.ok) return null; // no es MPEG-TS (fMP4, etc.): directo
        const result = verdict(codecs);
        remember(url, result);
        return result;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
