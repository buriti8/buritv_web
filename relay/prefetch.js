/**
 * Descarga anticipada de señales HLS.
 *
 * Algunos servidores entregan cada segmento más lento de lo que dura
 * (p. ej. DSPORTS opción 3: ~3,9 Mbps de señal y ~2-3 Mbps por conexión).
 * Bajándolos de a uno, como hacen hls.js y ffmpeg, la imagen se congela cada
 * pocos segundos; en paralelo sí alcanza. Además a veces cortan la conexión
 * a mitad de un segmento: lo recibido se conserva (como hace VLC) en vez de
 * volver a bajarlo entero.
 *
 * Por cada señal se mantiene una lista propia, servida en /p/<id>/index.m3u8,
 * con los segmentos ya descargados en memoria. ffmpeg (la retransmisión) lee
 * de ahí en vez de ir directo al servidor de origen.
 */
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';

// Segmentos que se bajan a la vez
const PARALLEL = 3;
// Segmentos publicados que se conservan en memoria
const KEEP = 10;
// Por debajo de esto (bytes) un segmento se da por fallido
const MIN_SEGMENT = 188 * 64;
const SEGMENT_TIMEOUT_MS = 20000;
// Espera máxima a que haya segmentos listos al pedir la lista
const READY_TIMEOUT_MS = 20000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

const feeds = new Map(); // id → feed

export const feedId = (src) => createHash('sha1').update(`feed|${src}`).digest('hex').slice(0, 16);

function request(url, timeout) {
    const mod = url.startsWith('https') ? https : http;
    return mod.get(url, { timeout, headers: { 'User-Agent': UA } });
}

function getText(url, hops = 0) {
    return new Promise((resolve, reject) => {
        const r = request(url, 10000);
        r.on('response', (up) => {
            if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location && hops < 5) {
                up.resume();
                return resolve(getText(new URL(up.headers.location, url).toString(), hops + 1));
            }
            let body = '';
            up.setEncoding('utf8');
            up.on('data', (c) => (body += c));
            up.on('end', () => resolve({ status: up.statusCode, text: body, url }));
            up.on('error', reject);
        });
        r.on('timeout', () => r.destroy(new Error('timeout')));
        r.on('error', reject);
    });
}

/** Baja un segmento. Si la conexión se corta, devuelve lo recibido (en paquetes TS completos). */
function getSegment(url, hops = 0) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            const buf = Buffer.concat(chunks, size);
            resolve(buf.subarray(0, buf.length - (buf.length % 188)));
        };
        const r = request(url, SEGMENT_TIMEOUT_MS);
        r.on('response', (up) => {
            if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location && hops < 5) {
                up.resume();
                done = true;
                return resolve(getSegment(new URL(up.headers.location, url).toString(), hops + 1));
            }
            if (up.statusCode !== 200) {
                up.resume();
                done = true;
                return resolve(Buffer.alloc(0));
            }
            up.on('data', (c) => {
                chunks.push(c);
                size += c.length;
            });
            up.on('end', finish);
            up.on('aborted', finish);
            up.on('error', finish);
            up.on('close', finish);
        });
        r.on('timeout', () => r.destroy(new Error('timeout')));
        r.on('error', finish);
    });
}

/** Lista maestra → la variante de mayor calidad; lista de segmentos → ella misma. */
async function resolveMedia(src) {
    const r = await getText(src);
    if (r.status !== 200) throw new Error(`lista ${r.status}`);
    if (!r.text.includes('#EXT-X-STREAM-INF')) return { url: r.url, text: r.text };
    const lines = r.text.split(/\r?\n/);
    let best = null;
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
        const bw = Number((lines[i].match(/BANDWIDTH=(\d+)/) || [])[1] || 0);
        const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
        if (uri && (!best || bw > best.bw)) best = { bw, url: new URL(uri.trim(), r.url).toString() };
    }
    if (!best) throw new Error('lista maestra sin variantes');
    return { url: best.url, text: null };
}

function parseMedia(text, base) {
    const lines = text.split(/\r?\n/);
    let seq = 0;
    let target = 4;
    const items = [];
    let dur = null;
    for (const line of lines) {
        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(line.slice(22)) || 0;
        else if (line.startsWith('#EXT-X-TARGETDURATION:')) target = Number(line.slice(22)) || target;
        else if (line.startsWith('#EXTINF:')) dur = parseFloat(line.slice(8)) || target;
        else if (line && !line.startsWith('#') && dur != null) {
            items.push({ seq: seq + items.length, dur, url: new URL(line.trim(), base).toString() });
            dur = null;
        }
    }
    return { target, items, ended: text.includes('#EXT-X-ENDLIST') };
}

function startFeed(id, src) {
    const f = {
        id,
        src,
        media: null,
        target: 4,
        lastAccess: Date.now(),
        stopped: false,
        timer: null,
        lastSeq: -1, // último segmento de origen agregado a la cola
        queue: [], // { seq, dur, url, state: queued|loading|done|failed, data }
        out: [], // publicados: { n, dur, data }
        nextN: 0,
        active: 0,
        failures: 0,
    };
    feeds.set(id, f);
    poll(f);
    return f;
}

async function poll(f) {
    if (f.stopped) return;
    try {
        if (!f.media) f.media = (await resolveMedia(f.src)).url;
        const r = await getText(f.media);
        if (r.status !== 200 || !r.text.includes('#EXTINF')) {
            // La lista de la sesión venció (Astra la renueva): volver a la maestra
            f.media = null;
            throw new Error(`lista ${r.status}`);
        }
        const pl = parseMedia(r.text, r.url);
        f.target = pl.target;
        // Si el origen reinició la numeración, empezar de nuevo
        if (pl.items.length && pl.items[pl.items.length - 1].seq < f.lastSeq - 50) f.lastSeq = -1;
        for (const it of pl.items) {
            if (it.seq <= f.lastSeq) continue;
            f.queue.push({ ...it, state: 'queued', data: null });
            f.lastSeq = it.seq;
        }
        f.failures = 0;
    } catch {
        f.failures += 1;
    }
    pump(f);
    const wait = Math.max(1000, Math.min(f.target * 500, 4000)) * Math.min(f.failures + 1, 4);
    f.timer = setTimeout(() => poll(f), wait);
}

function pump(f) {
    while (!f.stopped && f.active < PARALLEL) {
        const seg = f.queue.find((s) => s.state === 'queued');
        if (!seg) break;
        seg.state = 'loading';
        f.active += 1;
        load(f, seg).finally(() => {
            f.active -= 1;
            publish(f);
            pump(f);
        });
    }
}

async function load(f, seg) {
    let data = await getSegment(seg.url);
    // Un corte temprano: un reintento; si vuelve a fallar se salta el segmento
    if (data.length < MIN_SEGMENT && !f.stopped) data = await getSegment(seg.url);
    if (data.length >= MIN_SEGMENT) {
        seg.state = 'done';
        seg.data = data;
    } else {
        seg.state = 'failed';
    }
}

/** Pasa a la lista publicada los segmentos listos, en orden y sin huecos de espera. */
function publish(f) {
    while (f.queue.length && (f.queue[0].state === 'done' || f.queue[0].state === 'failed')) {
        const seg = f.queue.shift();
        if (seg.state === 'done') f.out.push({ n: f.nextN++, dur: seg.dur, data: seg.data });
    }
    if (f.out.length > KEEP) f.out.splice(0, f.out.length - KEEP);
}

export function stopFeed(id) {
    const f = feeds.get(id);
    if (!f) return;
    f.stopped = true;
    clearTimeout(f.timer);
    feeds.delete(id);
}

/** Asegura que la señal se esté bajando y devuelve su id. */
export function ensureFeed(src) {
    const id = feedId(src);
    const f = feeds.get(id) || startFeed(id, src);
    f.lastAccess = Date.now();
    return id;
}

export function stopIdleFeeds(idleMs) {
    const now = Date.now();
    for (const [id, f] of feeds) if (now - f.lastAccess > idleMs) stopFeed(id);
}

/** GET /p/<id>/<archivo>. Devuelve false si no es una ruta de esta parte. */
export async function handleFeed(req, res, url) {
    const m = url.pathname.match(/^\/p\/([a-f0-9]{16})\/(index\.m3u8|(\d+)\.ts)$/);
    if (!m) return false;
    const f = feeds.get(m[1]);
    if (!f) {
        res.writeHead(404);
        res.end();
        return true;
    }
    f.lastAccess = Date.now();
    if (m[3] != null) {
        const seg = f.out.find((s) => s.n === Number(m[3]));
        if (!seg) {
            res.writeHead(404);
            res.end();
            return true;
        }
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': seg.data.length });
        res.end(seg.data);
        return true;
    }
    const t0 = Date.now();
    while (f.out.length < 2 && !f.stopped && Date.now() - t0 < READY_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, 200));
    }
    if (f.out.length === 0) {
        res.writeHead(504);
        res.end();
        return true;
    }
    const target = Math.ceil(Math.max(f.target, ...f.out.map((s) => s.dur)));
    const body = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        `#EXT-X-TARGETDURATION:${target}`,
        `#EXT-X-MEDIA-SEQUENCE:${f.out[0].n}`,
        ...f.out.flatMap((s) => [`#EXTINF:${s.dur.toFixed(3)},`, `${s.n}.ts`]),
        '',
    ].join('\n');
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    res.end(body);
    return true;
}
