/**
 * BuriTV · retransmisión local
 *
 * Algunas señales traen audio MP2 (o video MPEG-2) que los navegadores no
 * reproducen. Este servicio las toma, copia el video tal cual (o lo pasa a
 * H.264 si hace falta) y convierte el audio a AAC, entregándolo como HLS
 * que cualquier navegador entiende.
 *
 *  - Bajo demanda: ffmpeg arranca cuando alguien pide la señal y se detiene
 *    solo si nadie la pide durante IDLE_MS. Varios espectadores comparten
 *    el mismo proceso.
 *  - Sin dependencias: solo Node y ffmpeg.
 *
 * Rutas:
 *   GET /health                         → { ok, ffmpeg, lan }
 *   GET /hls?src=<url>&video=copy|h264  → redirige a /s/<id>/index.m3u8
 *   GET /s/<id>/<archivo>               → lista y segmentos HLS
 *   GET /cast?src=<url>&video=auto|copy|h264 → { url } HLS listo para Chromecast (audio AAC, video H.264),
 *                                       con la dirección de la red local para que el Chromecast la alcance
 *   GET /frame-check?url=<url>          → { embeddable } (¿se puede mostrar en un iframe?)
 *   GET /page?url=<url>&m=0|1&v=0-1     → la página con el audio bajo control de BuriTV
 *   GET /m3u                          → la lista de canales (desde Google Drive)
 *   GET /now-playing                  → { updatedAt, channels: { <tvg-id>: partido } } (FotMob)
 *   GET /*                            → la web (carpeta dist), si existe
 *
 * Uso: docker compose up -d   (o npm run relay, con ffmpeg instalado)
 */
import http from 'node:http';
import https from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { networkInterfaces, tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { getNowPlaying } from './nowPlaying.js';

const PORT = Number(process.env.RELAY_PORT || 8090);
// Sin pedidos durante este tiempo, el proceso de ffmpeg se detiene
const IDLE_MS = 45000;
// Espera máxima a que ffmpeg tenga los primeros segmentos listos
const START_TIMEOUT_MS = 25000;
const WORK_DIR = join(tmpdir(), 'buritv-relay');
// Si existe la carpeta dist (npm run build), la web se sirve desde aquí mismo
const DIST_DIR = process.env.DIST_DIR || fileURLToPath(new URL('../dist', import.meta.url));

const FFMPEG = findFfmpeg();
const sessions = new Map(); // id → { proc, dir, lastAccess, src, dead }

function findFfmpeg() {
    for (const cmd of ['ffmpeg']) {
        try {
            const r = spawnSync(cmd, ['-version'], { stdio: 'ignore' });
            if (r.status === 0) return cmd;
        } catch {}
    }
    return null;
}

const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function send(res, status, body, headers = {}) {
    res.writeHead(status, { ...cors, ...headers });
    res.end(body);
}
const json = (res, status, obj) =>
    send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });

function sessionId(src, video) {
    return createHash('sha1').update(`${video}|${src}`).digest('hex').slice(0, 16);
}

function startSession(id, src, video) {
    const dir = join(WORK_DIR, id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const isHls = /\.m3u8(\?|$)/i.test(src);
    const args = [
        '-hide_banner',
        '-loglevel', 'fatal',
        '-fflags', '+genpts+discardcorrupt',
        // Reconexión automática si la señal TS directa se corta
        ...(isHls ? [] : ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5']),
        '-i', src,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        ...(video === 'h264'
            ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-g', '50', '-sc_threshold', '0']
            : ['-c:v', 'copy']),
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '6',
        '-hls_flags', 'delete_segments+omit_endlist+independent_segments',
        '-hls_segment_filename', join(dir, 'seg%05d.ts'),
        join(dir, 'index.m3u8'),
    ];
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const s = { proc, dir, src, lastAccess: Date.now(), dead: false };
    proc.stderr.on('data', (d) => {
        const msg = String(d).trim();
        if (msg) console.log(`[${id}] ${msg.split('\n')[0]}`);
    });
    proc.on('exit', (code) => {
        s.dead = true;
        console.log(`[${id}] ffmpeg terminó (${code})`);
    });
    sessions.set(id, s);
    console.log(`[${id}] inicia (${video}) ${src}`);
    return s;
}

function stopSession(id) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    try {
        s.proc.kill('SIGKILL');
    } catch {}
    setTimeout(() => rmSync(s.dir, { recursive: true, force: true }), 1500);
    console.log(`[${id}] detenida`);
}

// Lista lista para reproducir: al menos 2 segmentos
function playlistReady(dir) {
    const p = join(dir, 'index.m3u8');
    if (!existsSync(p)) return false;
    const segs = readFileSync(p, 'utf8').split('\n').filter((l) => l.endsWith('.ts'));
    return segs.length >= 2;
}

/**
 * Espera a que la sesión tenga lista la lista HLS. Si quien la pidió se va
 * (cambió de canal, cerró la pestaña) antes de que arranque y nadie más la
 * espera, se detiene ffmpeg de inmediato en vez de seguir bajando la señal
 * hasta IDLE_MS (con internet justo, esas señales abandonadas compiten con
 * la que sí se está viendo y la imagen se congela).
 * Devuelve 'ok' | 'aborted' | 'dead' | 'timeout'.
 */
async function waitReady(res, id, s) {
    let aborted = false;
    const onClose = () => {
        if (!res.writableEnded) aborted = true;
    };
    res.on('close', onClose);
    s.waiting = (s.waiting || 0) + 1;
    const t0 = Date.now();
    try {
        while (!playlistReady(s.dir)) {
            if (aborted) {
                if (s.waiting <= 1 && !s.served) stopSession(id);
                return 'aborted';
            }
            if (s.dead) return 'dead';
            if (Date.now() - t0 > START_TIMEOUT_MS) return 'timeout';
            await new Promise((r) => setTimeout(r, 250));
        }
        s.served = true;
        return 'ok';
    } finally {
        s.waiting -= 1;
        res.off('close', onClose);
    }
}

async function handleHls(req, res, url) {
    const src = url.searchParams.get('src');
    const video = url.searchParams.get('video') === 'h264' ? 'h264' : 'copy';
    if (!src || !/^https?:\/\//i.test(src)) return json(res, 400, { error: 'src inválido' });
    if (!FFMPEG) return json(res, 503, { error: 'ffmpeg no está instalado' });

    const id = sessionId(src, video);
    let s = sessions.get(id);
    if (s && s.dead) {
        stopSession(id);
        s = null;
    }
    if (!s) s = startSession(id, src, video);
    s.lastAccess = Date.now();

    const ready = await waitReady(res, id, s);
    if (ready === 'aborted') return;
    if (ready === 'dead') return json(res, 502, { error: 'la señal no responde' });
    if (ready === 'timeout') return json(res, 504, { error: 'la señal tarda demasiado' });
    send(res, 302, '', { Location: `/s/${id}/index.m3u8`, 'Cache-Control': 'no-store' });
}

// ── Chromecast ───────────────────────────────────────────────────────────
// El Chromecast baja la señal por su cuenta desde la red local: la dirección
// no puede ser "localhost". Se prefiere la de Wi-Fi/Ethernet real, no las
// virtuales (WSL, VirtualBox, VMware, Hyper-V). RELAY_PUBLIC_HOST la fuerza.
const VIRTUAL_NIC = /vethernet|virtualbox|vmware|vbox|wsl|hyper-v|docker|loopback|tailscale|zerotier/i;
function lanUrls() {
    if (process.env.RELAY_PUBLIC_HOST) return [`http://${process.env.RELAY_PUBLIC_HOST}:${PORT}`];
    const out = [];
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
        if (VIRTUAL_NIC.test(name)) continue;
        for (const a of addrs || []) {
            if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
            // Las redes locales primero (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
            const priv = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
            // Wi-Fi/Ethernet real antes que redes de laboratorio (VirtualBox usa 192.168.56.x)
            const score = Number(priv) + Number(!a.address.startsWith('192.168.56.')) * 2 + (/wi-?fi|wlan|wireless|inal/i.test(name) ? 4 : 0);
            out.push({ url: `http://${a.address}:${PORT}`, score });
        }
    }
    return out.sort((x, y) => y.score - x.score).map((o) => o.url);
}

// ¿El video ya es H.264? Chromecast no reproduce MPEG-2 (varias señales de TV
// abierta lo traen). Sin ffprobe se asume que hay que convertirlo.
const codecCache = new Map();
function probeVideoCodec(src) {
    if (codecCache.has(src)) return Promise.resolve(codecCache.get(src));
    const probe = FFMPEG ? FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1') : null;
    return new Promise((resolve) => {
        if (!probe) return resolve('unknown');
        const p = spawn(
            probe,
            ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', src],
            { stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 },
        );
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.on('error', () => resolve('unknown'));
        p.on('close', () => {
            const codec = out.trim().split(/\s+/)[0] || 'unknown';
            if (codec !== 'unknown') codecCache.set(src, codec);
            resolve(codec);
        });
    });
}

async function handleCast(req, res, url) {
    const src = url.searchParams.get('src');
    if (!src || !/^https?:\/\//i.test(src)) return json(res, 400, { error: 'src inválido' });
    if (!FFMPEG) return json(res, 503, { error: 'ffmpeg no está instalado' });
    let video = url.searchParams.get('video');
    if (video !== 'copy' && video !== 'h264') video = (await probeVideoCodec(src)) === 'h264' ? 'copy' : 'h264';

    const id = sessionId(src, video);
    let s = sessions.get(id);
    if (s && s.dead) {
        stopSession(id);
        s = null;
    }
    if (!s) s = startSession(id, src, video);
    s.lastAccess = Date.now();
    const ready = await waitReady(res, id, s);
    if (ready === 'aborted') return;
    if (ready === 'dead') return json(res, 502, { error: 'la señal no responde' });
    if (ready === 'timeout') return json(res, 504, { error: 'la señal tarda demasiado' });
    // Si quien pregunta ya llegó por una dirección de la red local, esa misma
    // sirve; si llegó por localhost, se usa la del equipo en la red.
    const hostName = String(req.headers.host || '').replace(/:\d+$/, '');
    const loopback = !hostName || /^(localhost|127\.|\[?::1\]?$)/i.test(hostName);
    const base = loopback ? lanUrls()[0] : `http://${req.headers.host}`;
    if (!base) return json(res, 500, { error: 'no se encontró la dirección de la red local' });
    json(res, 200, { url: `${base}/s/${id}/index.m3u8`, video });
}

function handleFile(req, res, id, file) {
    const s = sessions.get(id);
    if (!s || !/^[\w.-]+$/.test(file)) return send(res, 404, 'no existe');
    s.lastAccess = Date.now();
    const p = join(s.dir, file);
    if (!existsSync(p)) return send(res, 404, 'no existe');
    const isList = file.endsWith('.m3u8');
    res.writeHead(200, {
        ...cors,
        'Content-Type': isList ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        'Content-Length': statSync(p).size,
        'Cache-Control': isList ? 'no-store' : 'max-age=60',
    });
    createReadStream(p).pipe(res);
}

// Lista de canales desde Drive (el navegador no puede bajarla directo:
// Drive rechaza las descargas hechas desde otra página)
const M3U_DRIVE_ID = '1OK6_rn5hFGB0WgpG4XqIR-FR6qlIYBL7';
const M3U_URLS = [
    `https://drive.usercontent.google.com/download?id=${M3U_DRIVE_ID}&export=download`,
    `https://drive.google.com/uc?export=download&id=${M3U_DRIVE_ID}`,
];
let m3uCache = { text: null, at: 0 };

function getText(url, hops = 0) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const r = mod.get(url, { timeout: 12000, headers: { 'User-Agent': 'BuriTV/1.0' } }, (up) => {
            if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location && hops < 5) {
                up.resume();
                return resolve(getText(new URL(up.headers.location, url).toString(), hops + 1));
            }
            const chunks = [];
            up.on('data', (c) => chunks.push(c));
            up.on('end', () => resolve({ status: up.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
            up.on('error', reject);
        });
        r.on('timeout', () => r.destroy(new Error('timeout')));
        r.on('error', reject);
    });
}

async function handleM3u(req, res) {
    const headers = { 'Content-Type': 'audio/x-mpegurl; charset=utf-8', 'Cache-Control': 'no-store' };
    if (m3uCache.text && Date.now() - m3uCache.at < 300000) return send(res, 200, m3uCache.text, headers);
    for (const url of M3U_URLS) {
        try {
            const r = await getText(url);
            if (r.status === 200 && r.text.includes('#EXTINF')) {
                m3uCache = { text: r.text, at: Date.now() };
                return send(res, 200, r.text, headers);
            }
        } catch {}
    }
    if (m3uCache.text) return send(res, 200, m3uCache.text, headers);
    send(res, 502, 'No se pudo descargar la lista');
}

// ¿La página permite mostrarse dentro de un iframe? (X-Frame-Options / CSP)
const frameCache = new Map();
function handleFrameCheck(req, res, url) {
    const target = url.searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) return json(res, 400, { error: 'url inválida' });
    if (frameCache.has(target)) return json(res, 200, frameCache.get(target));
    const mod = target.startsWith('https') ? https : http;
    const r = mod.get(target, { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (up) => {
        up.resume();
        const xfo = String(up.headers['x-frame-options'] || '').toLowerCase();
        const csp = String(up.headers['content-security-policy'] || '').toLowerCase();
        const blocked =
            xfo.includes('deny') ||
            xfo.includes('sameorigin') ||
            /frame-ancestors\s+('none'|'self')/.test(csp);
        const result = { embeddable: !blocked, status: up.statusCode };
        frameCache.set(target, result);
        json(res, 200, result);
    });
    r.on('timeout', () => r.destroy());
    r.on('error', () => json(res, 200, { embeddable: true, unknown: true }));
}

// ── Páginas web con reproductor propio ───────────────────────────────────
// Muchas fijan el reproductor en silencio y su botón de sonido queda fuera de
// alcance. Se sirve la página con un script que toma el control del audio de
// sus <video>/<audio> y obedece a BuriTV (postMessage {buritv:'audio'}).
// Además, la página ve su propia ruta y parámetros (muchas eligen el canal con
// ?id=… leyendo location.search) y, si intenta irse (p. ej. porque comprueba
// location.hostname y redirige), avisa a BuriTV para cargarla directa.
const AUDIO_SCRIPT = (muted, volume, href) => `<script>(function(){
try{var t=new URL(${JSON.stringify(href).replace(/</g, '\\u003c')});history.replaceState(history.state,'',t.pathname+t.search+t.hash);}catch(e){}
addEventListener('beforeunload',function(){try{parent.postMessage({buritv:'leave'},'*');}catch(e){}});
var st={m:${muted ? 'true' : 'false'},v:${Number(volume) || 1}};
var P=HTMLMediaElement.prototype;
var dm=Object.getOwnPropertyDescriptor(P,'muted'),dv=Object.getOwnPropertyDescriptor(P,'volume');
function apply(el){try{dm.set.call(el,st.m);dv.set.call(el,st.v);}catch(e){}}
function all(){document.querySelectorAll('video,audio').forEach(apply);}
try{Object.defineProperty(P,'muted',{get:function(){return dm.get.call(this);},set:function(){dm.set.call(this,st.m);},configurable:true});
Object.defineProperty(P,'volume',{get:function(){return dv.get.call(this);},set:function(){dv.set.call(this,st.v);},configurable:true});}catch(e){}
['play','playing','loadedmetadata','volumechange'].forEach(function(t){document.addEventListener(t,function(e){var el=e.target;if(el&&el.tagName&&/^(VIDEO|AUDIO)$/.test(el.tagName)&&(dm.get.call(el)!==st.m||dv.get.call(el)!==st.v))apply(el);},true);});
setInterval(all,700);
addEventListener('message',function(e){var d=e.data;if(d&&d.buritv==='audio'){st.m=!!d.muted;st.v=Math.min(1,Math.max(0,Number(d.volume)));all();}});
})();</script>`;

function handlePage(req, res, url) {
    const target = url.searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) return json(res, 400, { error: 'url inválida' });
    const muted = url.searchParams.get('m') !== '0';
    const volume = url.searchParams.get('v') ?? '1';
    const fetchPage = (href, hops) => {
        const u = new URL(href);
        const mod = u.protocol === 'https:' ? https : http;
        const up = mod.get(
            href,
            {
                timeout: 12000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
                    Referer: `${u.origin}/`,
                    'Accept-Encoding': 'identity',
                    'Accept-Language': 'es-ES,es;q=0.9',
                },
            },
            (r) => {
                if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 4) {
                    r.resume();
                    return fetchPage(new URL(r.headers.location, href).toString(), hops + 1);
                }
                const chunks = [];
                r.on('data', (c) => chunks.push(c));
                r.on('end', () => {
                    let html = Buffer.concat(chunks).toString('utf8');
                    const inject = `<base href="${href}">${AUDIO_SCRIPT(muted, volume, href)}`;
                    html = /<head[^>]*>/i.test(html)
                        ? html.replace(/<head[^>]*>/i, (h) => h + inject)
                        : inject + html;
                    send(res, r.statusCode || 200, html, {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Cache-Control': 'no-store',
                    });
                });
            },
        );
        up.on('timeout', () => up.destroy());
        up.on('error', () => send(res, 502, 'no disponible'));
    };
    try {
        fetchPage(target, 0);
    } catch {
        json(res, 400, { error: 'url inválida' });
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.map': 'application/json',
};

// Archivos de la web (dist). Devuelve false si no existe.
function handleStatic(req, res, url) {
    if (req.method !== 'GET' || !existsSync(DIST_DIR)) return false;
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const p = normalize(join(DIST_DIR, rel));
    if (!p.startsWith(normalize(DIST_DIR)) || !existsSync(p) || !statSync(p).isFile()) return false;
    res.writeHead(200, {
        'Content-Type': MIME[extname(p).toLowerCase()] || 'application/octet-stream',
        'Content-Length': statSync(p).size,
        'Cache-Control': p.endsWith('sw.js') || p.endsWith('index.html') ? 'no-cache' : 'max-age=3600',
    });
    createReadStream(p).pipe(res);
    return true;
}

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const m = url.pathname.match(/^\/s\/([a-f0-9]{16})\/([^/]+)$/);
    if (url.pathname === '/health') return json(res, 200, { ok: true, ffmpeg: !!FFMPEG, lan: lanUrls() });
    if (url.pathname === '/cast') return handleCast(req, res, url).catch(() => json(res, 500, {}));
    if (url.pathname === '/hls') return handleHls(req, res, url).catch(() => json(res, 500, {}));
    if (url.pathname === '/frame-check') return handleFrameCheck(req, res, url);
    if (url.pathname === '/page') return handlePage(req, res, url);
    if (url.pathname === '/m3u') return handleM3u(req, res).catch(() => send(res, 500, ''));
    if (url.pathname === '/now-playing')
        return getNowPlaying()
            .then((data) => send(res, 200, JSON.stringify(data), { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=30' }))
            .catch(() => json(res, 200, { updatedAt: Date.now(), channels: {} }));
    if (m) return handleFile(req, res, m[1], m[2]);
    if (handleStatic(req, res, url)) return;
    send(res, 404, 'no existe');
});

// Detener lo que nadie está viendo
setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastAccess > IDLE_MS) stopSession(id);
}, 10000);

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        for (const id of [...sessions.keys()]) stopSession(id);
        setTimeout(() => process.exit(0), 300);
    });
}

rmSync(WORK_DIR, { recursive: true, force: true });
mkdirSync(WORK_DIR, { recursive: true });
server.listen(PORT, '0.0.0.0', () => {
    console.log(`BuriTV retransmisión en http://localhost:${PORT}`);
    console.log(FFMPEG ? `ffmpeg: ${FFMPEG}` : 'AVISO: no se encontró ffmpeg');
});
