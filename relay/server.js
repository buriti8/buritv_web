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
 *   GET /epg                          → { updatedAt, channels: { <tvg-id>: [programas] } } (open-epg)
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
import { ensureFeed, handleFeed, stopFeed, stopIdleFeeds } from './prefetch.js';
import { getEpg, warmEpg } from './epg.js';

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
    // HLS: ffmpeg lee la copia local que se baja en paralelo (prefetch.js), no el origen
    const feed = isHls ? ensureFeed(src) : null;
    const input = feed ? `http://127.0.0.1:${PORT}/p/${feed}/index.m3u8` : src;
    const args = [
        '-hide_banner',
        '-loglevel', 'fatal',
        '-fflags', '+genpts+discardcorrupt',
        // Reconexión automática si la señal TS directa se corta
        ...(isHls ? [] : ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5']),
        '-i', input,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        ...(video === 'h264'
            ? [
                  // Desentrelazar solo los cuadros entrelazados (TV abierta en MPEG-2)
                  '-vf', 'yadif=deint=interlaced',
                  '-c:v', 'libx264', '-preset', 'faster', '-tune', 'zerolatency',
                  // Calidad constante alta (23 por defecto perdía detalle en señales
                  // SD ya pobres), con tope para no saturar conexiones lentas
                  '-crf', '20', '-maxrate', '6M', '-bufsize', '12M',
                  '-pix_fmt', 'yuv420p', '-g', '50', '-sc_threshold', '0',
              ]
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
    const s = { proc, dir, src, feed, lastAccess: Date.now(), dead: false };
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
    // La descarga anticipada se detiene si ninguna otra sesión usa la misma señal
    if (s.feed && ![...sessions.values()].some((o) => o.feed === s.feed)) stopFeed(s.feed);
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
    let video = url.searchParams.get('video') === 'h264' ? 'h264' : 'copy';
    if (!src || !/^https?:\/\//i.test(src)) return json(res, 400, { error: 'src inválido' });
    if (!FFMPEG) return json(res, 503, { error: 'ffmpeg no está instalado' });
    // "copy" solo sirve si el navegador decodifica ese video. Con MPEG-2/HEVC
    // (TV abierta, TyC…) hls.js reproduce solo el audio, sin dar error, así que
    // se convierte a H.264 aunque la web haya pedido copiarlo.
    if (video === 'copy' && NON_BROWSER_VIDEO.has(await probeVideoCodec(src))) video = 'h264';

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
// Videos que los navegadores no decodifican
const NON_BROWSER_VIDEO = new Set(['mpeg2video', 'mpeg1video', 'hevc']);
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
            // La salida puede traer comas de más ("mpeg2video,") y repetirse por programa
            const codec = out.trim().split(/[\s,]+/)[0] || 'unknown';
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

// Cabeceras de un navegador cargando la página dentro de un iframe. Algunas
// páginas (p. ej. la opción 1 de TNT SPORTS, la18hd) responden 403 vacío si
// falta Sec-Fetch-Dest, y en BuriTV quedaba la pantalla en blanco.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IFRAME_HEADERS = {
    'User-Agent': BROWSER_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9',
    'Sec-Fetch-Dest': 'iframe',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site',
    'Upgrade-Insecure-Requests': '1',
};

// ¿La página permite mostrarse dentro de un iframe? (X-Frame-Options / CSP)
const frameCache = new Map();
function handleFrameCheck(req, res, url) {
    const target = url.searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) return json(res, 400, { error: 'url inválida' });
    if (frameCache.has(target)) return json(res, 200, frameCache.get(target));
    const mod = target.startsWith('https') ? https : http;
    const r = mod.get(target, { timeout: 8000, headers: IFRAME_HEADERS }, (up) => {
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
//
// Algunas comprueban location.hostname y se van si no es el suyo (p. ej. la
// opción 2 de DSPORTS, con el código ofuscado y armado con Function). Como
// location no se puede redefinir, se reescribe ese acceso por __buritvLoc
// (con el dominio original) en sus scripts en línea y en el código que armen
// con Function.
//
// Con Bitmovin (DSPORTS opciones 1 y 2) el audio se maneja con la API del
// reproductor: arranca silenciado (así el autoplay nunca falla) y luego se
// le quita el silencio. Forzar video.muted por debajo hacía fallar su
// arranque (pantalla negra) o lo dejaba mudo.
const LOC_RE = /\b(?:window\.|document\.)?location\.(hostname|host|origin)\b(?!\s*=[^=])/g;
// location["hostname"] / location[variable] (DSPORTS 2 opción 2, sudamericaplay:
// arma con Function `if (location[a[0]] !== a[1]) location.replace(google)`):
// pasa por __buritvL, que da el dominio original y deja el resto al location real.
const LOC_BRACKET_RE = /(^|[^.\w$])(?:window\.|document\.)?location\[/g;
const fixLocation = (code) => code.replace(LOC_RE, '__buritvLoc.$1').replace(LOC_BRACKET_RE, '$1__buritvL[');
const AUDIO_SCRIPT = (muted, volume, href) => `<script>(function(){
var t;try{t=new URL(${JSON.stringify(href).replace(/</g, '\\u003c')});history.replaceState(history.state,'',t.pathname+t.search+t.hash);}catch(e){}
window.__buritvLoc=t?{hostname:t.hostname,host:t.host,origin:t.origin}:location;
try{window.__buritvL=new Proxy({},{get:function(o,k){if(k==='hostname'||k==='host'||k==='origin')return __buritvLoc[k];var v=location[k];return typeof v==='function'?v.bind(location):v;},
set:function(o,k,v){location[k]=v;return true;}});}catch(e){window.__buritvL=location;}
var LR=${LOC_RE.toString()},LB=${LOC_BRACKET_RE.toString()};
function fix(c){return typeof c==='string'&&c.indexOf('location')!==-1?c.replace(LR,'__buritvLoc.$1').replace(LB,'$1__buritvL['):c;}
try{var OF=Function;var NF=function(){var a=[].slice.call(arguments);if(a.length)a[a.length-1]=fix(String(a[a.length-1]));return OF.apply(this,a);};
NF.prototype=OF.prototype;Object.defineProperty(OF.prototype,'constructor',{value:NF,writable:true,configurable:true});window.Function=NF;}catch(e){}
addEventListener('beforeunload',function(){try{parent.postMessage({buritv:'leave'},'*');}catch(e){}});
var st={m:${muted ? 'true' : 'false'},v:${Number(volume) || 1}};
var P=HTMLMediaElement.prototype;
var dm=Object.getOwnPropertyDescriptor(P,'muted'),dv=Object.getOwnPropertyDescriptor(P,'volume');
// ── Bitmovin ──
var bms=[],bmLib,BM=false;
function bmApply(p){try{if(st.m){p.mute();return;}p.setVolume(Math.round(st.v*100));if(p.isMuted()){p.unmute();
setTimeout(function(){try{if(p.isPaused()&&!p.isMuted()){p.mute();p.play();}}catch(e){}},600);}}catch(e){}}
function bmWrap(lib){try{var O=lib&&lib.player&&lib.player.Player;if(!O||O.__buritv)return;
var W=function(el,cfg){BM=true;cfg=cfg||{};cfg.playback=Object.assign({},cfg.playback,{muted:true,autoplay:true});
var p=new O(el,cfg);bms.push(p);var ev=lib.player.PlayerEvent||{};
try{p.on(ev.Playing||'playing',function(){if(!p.__buritvOn){p.__buritvOn=1;bmApply(p);}});}catch(e){}
return p;};W.prototype=O.prototype;W.__buritv=true;Object.keys(O).forEach(function(k){try{W[k]=O[k];}catch(e){}});
lib.player.Player=W;}catch(e){}}
try{Object.defineProperty(window,'bitmovin',{configurable:true,get:function(){bmWrap(bmLib);return bmLib;},set:function(v){bmLib=v;bmWrap(v);}});}catch(e){}
// ── <video>/<audio> sueltos ──
function apply(el){if(BM)return;try{dm.set.call(el,st.m);dv.set.call(el,st.v);}catch(e){}}
function all(){if(BM){bms.forEach(bmApply);return;}document.querySelectorAll('video,audio').forEach(apply);}
try{Object.defineProperty(P,'muted',{get:function(){return dm.get.call(this);},set:function(x){dm.set.call(this,BM?x:st.m);},configurable:true});
Object.defineProperty(P,'volume',{get:function(){return dv.get.call(this);},set:function(x){dv.set.call(this,BM?x:st.v);},configurable:true});}catch(e){}
['play','playing','loadedmetadata','volumechange'].forEach(function(t){document.addEventListener(t,function(e){var el=e.target;if(!BM&&el&&el.tagName&&/^(VIDEO|AUDIO)$/.test(el.tagName)&&(dm.get.call(el)!==st.m||dv.get.call(el)!==st.v))apply(el);},true);});
setInterval(function(){if(!BM)all();},700);
addEventListener('message',function(e){var d=e.data;if(d&&d.buritv==='audio'){st.m=!!d.muted;st.v=Math.min(1,Math.max(0,Number(d.volume)));all();
if(e.source===parent)for(var i=0;i<frames.length;i++)try{frames[i].postMessage(d,'*');}catch(x){}}});
})();</script>`;

// Publicidad de las páginas con reproductor propio (igual que en la app móvil):
//  - aclib (en TYC SPORTS opción 3 abría un anuncio gigante encima del video):
//    su cargador en línea (window['…']='…', ~650 KB) y sus llamadas se quitan,
//    y por si llega de otra forma, queda sin efecto (todo lo que le pidan no hace nada).
//  - Scripts externos con data-cfasync="false" vacíos: popunders.
//  - window.open: sin ventanas emergentes.
// Y que no arranquen silenciados (JW Player de dembed.st: "start_muted":true).
// Solo se quitan los scripts que son únicamente publicidad: el que llama a
// aclib.runPop({...}) y nada más, y su cargador. Quitar cualquiera que
// nombrara aclib borraba el reproductor de streamxhd (DSPORTS 2 y DSPORTS +
// opción 1), que la menciona dentro de su código.
// También la etiqueta de anuncios por zona: s.dataset.zone='…', s.src='…/tag.min.js'.
const AD_ONLY_SCRIPT =
    /^\s*(aclib\.\w+\(\s*\{[^{}]*\}\s*\);?\s*)+$|^\s*window\[['"][A-Za-z0-9]{10,}['"]\]\s*=\s*['"]|^[^\n]{0,400}dataset\.zone\s*=[^\n]{0,200}tag\.min\.js[^\n]{0,200}$/;
// Detectores de "iframe con sandbox" (quitan la publicidad así): si sospechan,
// mandan a /block.html. En BuriTV daban falsos positivos (p. ej. con el objeto
// PDF de prueba) y la página se iba (DSPORTS 2 opción 2 quedaba sin sonido).
const SANDBOX_CHECK = /sandbox[\s\S]*block\.html|block\.html[\s\S]*sandbox/;
const cleanPlayerHtml = (html) =>
    html
        .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (all, code) =>
            AD_ONLY_SCRIPT.test(code) || (code.length < 6000 && SANDBOX_CHECK.test(code)) ? '' : all,
        )
        .replace(/<script\b[^>]*data-cfasync=["']false["'][^>]*>\s*<\/script>/gi, '')
        .replace(/(["']start_muted["']\s*:\s*)true/g, '$1false');
const NO_POPUPS_SCRIPT = `<script>(function(){window.open=function(){return null;};
try{var n=new Proxy(function(){},{get:function(){return n;},apply:function(){return n;}});
Object.defineProperty(window,'aclib',{get:function(){return n;},set:function(){},configurable:false});}catch(e){}})();</script>`;

// Reproductor anidado servido por la retransmisión (ver needsOwnReferer): sus
// pedidos de red (lista, segmentos, token…) salen por /fwd, que los hace con
// su dominio como Origin/Referer. La página sigue viendo las direcciones
// originales (responseURL / Response.url), así las rutas relativas de la
// lista HLS se resuelven bien. document.referrer es la página que lo envolvía.
const NET_SCRIPT = (origin, referrer) => `<script>(function(){
var O=${JSON.stringify(origin).replace(/</g, '\\u003c')},RF=${JSON.stringify(referrer).replace(/</g, '\\u003c')},RL=location.origin;
try{Object.defineProperty(Document.prototype,'referrer',{get:function(){return RF;},configurable:true});}catch(e){}
function abs(u){try{return new URL(String(u),document.baseURI);}catch(e){return null;}}
function wrap(a){return a&&/^https?:$/.test(a.protocol)&&a.origin!==RL?RL+'/fwd?o='+encodeURIComponent(O)+'&url='+encodeURIComponent(a.href):null;}
var X=XMLHttpRequest.prototype,XO=X.open,RU=Object.getOwnPropertyDescriptor(X,'responseURL');
X.open=function(m,u){var a=abs(u),w=wrap(a);this.__bu=w?a.href:null;if(w)arguments[1]=w;return XO.apply(this,arguments);};
try{Object.defineProperty(X,'responseURL',{get:function(){return this.__bu||RU.get.call(this);},configurable:true});}catch(e){}
var F=window.fetch;if(F)window.fetch=function(i,o){var isReq=typeof Request!=='undefined'&&i instanceof Request;var a=abs(isReq?i.url:i),w=wrap(a);
if(!w)return F.apply(this,arguments);var p=isReq?F.call(this,new Request(w,i),o):F.call(this,w,o);
return p.then(function(r){try{Object.defineProperty(r,'url',{value:a.href});}catch(e){}return r;});};
})();</script>`;

// Algunas páginas solo envuelven el reproductor de otro dominio, y ese
// reproductor exige que lo pida la página original (Referer). Pasada por la
// retransmisión, el navegador lo pide desde aquí y se niega (la opción 2 de
// TYC SPORTS: dembed.st respondía "Not allowed to stream"). Cargada directa
// se veía, pero arrancaba sin sonido y su botón quedaba fuera de alcance.
// Así que ese reproductor también se sirve desde aquí (pedido con la página
// original como Referer), con el control del audio y con su red por /fwd: su
// señal solo acepta su propio dominio como Origin.
// Se prueba el reproductor anidado con los dos Referer y se recuerda.
const ownRefCache = new Map(); // url del iframe → ¿exige la página original?
function statusWithReferer(target, referer) {
    return new Promise((resolve) => {
        const mod = target.protocol === 'https:' ? https : http;
        const r = mod.get(target, { timeout: 6000, headers: { ...IFRAME_HEADERS, Referer: referer } }, (up) => {
            resolve(up.statusCode);
            up.destroy();
        });
        r.on('timeout', () => r.destroy());
        r.on('error', () => resolve(0));
    });
}
async function needsOwnReferer(html, href, req) {
    const page = new URL(href);
    const relayRef = `http://${req.headers.host || 'localhost'}/`;
    const frames = [...html.matchAll(/<iframe\b([^>]*)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>/gi)]
        .map((m) => {
            try {
                return {
                    raw: m[2],
                    f: new URL(m[2].replace(/&amp;/g, '&'), href),
                    fs: /allowfullscreen/i.test(m[1] + m[3]),
                };
            } catch {
                return null;
            }
        })
        .filter((x) => x && /^https?:$/.test(x.f.protocol) && x.f.host !== page.host)
        .slice(0, 3);
    // Un único iframe de otro dominio con pantalla completa: es el reproductor
    // y la página solo lo envuelve. dembed.st (TYC SPORTS opción 3) dejó de
    // exigir el Referer, pero igual conviene servirlo desde aquí: así se le
    // quita la publicidad y que arranque en silencio (ver cleanPlayerHtml).
    const onlyPlayer = frames.filter((x) => x.fs).length === 1;
    const checks = frames.map(async ({ f, fs }) => {
        const key = f.toString();
        if (!ownRefCache.has(key)) {
            const [own, relay] = await Promise.all([
                statusWithReferer(f, `${page.origin}/`),
                statusWithReferer(f, relayRef),
            ]);
            // Con la página original responde, y desde aquí se niega o es el único reproductor
            const result = own >= 200 && own < 400 && (relay === 401 || relay === 403 || (onlyPlayer && fs));
            if (!own || !relay) return result; // sin respuesta: no se recuerda
            ownRefCache.set(key, result);
        }
        return ownRefCache.get(key);
    });
    const results = await Promise.all(checks);
    // [{ raw, f, sole }] (sole: es el único reproductor de la página)
    return frames.filter((_, i) => results[i]).map((x) => ({ ...x, sole: onlyPlayer && x.fs }));
}

// Pedidos de red de un reproductor anidado, hechos con su dominio (o=origen)
function handleFwd(req, res, url) {
    const target = url.searchParams.get('url');
    const origin = url.searchParams.get('o');
    const corsH = {
        'Access-Control-Allow-Origin': req.headers.origin || '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Expose-Headers': '*',
        Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            ...corsH,
            'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
            'Access-Control-Max-Age': '600',
            'Access-Control-Allow-Private-Network': 'true',
        });
        return res.end();
    }
    if (!target || !/^https?:\/\//i.test(target) || !origin || !/^https?:\/\//i.test(origin)) {
        res.writeHead(400, corsH);
        return res.end();
    }
    const body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
        const payload = Buffer.concat(body);
        const go = (href, hops) => {
            let u;
            try {
                u = new URL(href);
            } catch {
                res.writeHead(400, corsH);
                return res.end();
            }
            const headers = {
                'User-Agent': BROWSER_UA,
                Accept: req.headers.accept || '*/*',
                'Accept-Language': 'es-ES,es;q=0.9',
                'Accept-Encoding': 'identity',
                Origin: origin,
                Referer: `${origin}/`,
                'Sec-Fetch-Site': 'cross-site',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
            };
            for (const h of ['content-type', 'range']) if (req.headers[h]) headers[h] = req.headers[h];
            if (payload.length) headers['Content-Length'] = payload.length;
            const mod = u.protocol === 'https:' ? https : http;
            const up = mod.request(href, { method: req.method, headers, timeout: 15000 }, (r) => {
                if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 4) {
                    r.resume();
                    return go(new URL(r.headers.location, href).toString(), hops + 1);
                }
                const out = { ...corsH };
                for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'])
                    if (r.headers[h]) out[h] = r.headers[h];
                res.writeHead(r.statusCode || 502, out);
                r.pipe(res);
            });
            up.on('timeout', () => up.destroy());
            up.on('error', () => {
                if (!res.headersSent) res.writeHead(502, corsH);
                res.end();
            });
            up.end(payload.length ? payload : undefined);
        };
        go(target, 0);
    });
}

function handlePage(req, res, url) {
    const target = url.searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) return json(res, 400, { error: 'url inválida' });
    const muted = url.searchParams.get('m') !== '0';
    const volume = url.searchParams.get('v') ?? '1';
    // Reproductor anidado: la página que lo envolvía (se pide con ella como Referer)
    const ref = url.searchParams.get('ref');
    const nested = !!ref && /^https?:\/\//i.test(ref);
    const relayOrigin = `${String(req.headers['x-forwarded-proto'] || 'http').split(',')[0]}://${req.headers.host}`;
    const fetchPage = (href, hops) => {
        const u = new URL(href);
        const mod = u.protocol === 'https:' ? https : http;
        const up = mod.get(
            href,
            {
                timeout: 12000,
                headers: {
                    ...IFRAME_HEADERS,
                    Referer: nested ? ref : `${u.origin}/`,
                    'Accept-Encoding': 'identity',
                },
            },
            (r) => {
                if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 4) {
                    r.resume();
                    return fetchPage(new URL(r.headers.location, href).toString(), hops + 1);
                }
                const chunks = [];
                r.on('data', (c) => chunks.push(c));
                r.on('end', async () => {
                    let html = Buffer.concat(chunks).toString('utf8');
                    // Reproductores anidados que solo aceptan la página original: también desde aquí
                    if (!nested) {
                        const players = await needsOwnReferer(html, href, req);
                        // La página solo envuelve el reproductor (con su margen blanco y su
                        // publicidad alrededor): se sirve directamente el reproductor, que
                        // ocupa todo (igual que en la app). Ya está dentro del iframe de
                        // BuriTV, así que sigue "embebido".
                        const sole = players.find((x) => x.sole);
                        if (sole) {
                            res.writeHead(302, {
                                ...cors,
                                Location: `/page?url=${encodeURIComponent(sole.f.toString())}&ref=${encodeURIComponent(`${new URL(href).origin}/`)}&m=${muted ? 1 : 0}&v=${volume}`,
                                'Cache-Control': 'no-store',
                            });
                            return res.end();
                        }
                        for (const { raw, f } of players) {
                            const src = `${relayOrigin}/page?url=${encodeURIComponent(f.toString())}&ref=${encodeURIComponent(`${new URL(href).origin}/`)}&m=${muted ? 1 : 0}&v=${volume}`;
                            html = html.split(`"${raw}"`).join(`"${src}"`).split(`'${raw}'`).join(`'${src}'`);
                        }
                    }
                    // Sin publicidad y sin arrancar en silencio
                    html = cleanPlayerHtml(html);
                    // Scripts en línea: que vean el dominio original
                    html = html.replace(
                        /(<script(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)(<\/script>)/gi,
                        (_, open, code, close) => open + fixLocation(code) + close,
                    );
                    // Reproductores configurados para esperar un clic (TNT SPORTS opción 1,
                    // Clappr con "autoPlay":false): en BuriTV ya se eligió el canal, que arranquen
                    html = html.replace(/(<script(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)(<\/script>)/gi, (_, open, code, close) =>
                        open + code.replace(/(["']?autoPlay["']?\s*:\s*)false\b/g, '$1true') + close,
                    );
                    // El script va antes del <base>: con el <base> ya puesto, history.replaceState
                    // resolvía la ruta contra el otro dominio, fallaba y la página no veía su
                    // ?id=… (DSPORTS opción 1 mostraba "Canal no disponible")
                    const inject = `${NO_POPUPS_SCRIPT}${nested ? NET_SCRIPT(new URL(href).origin, ref) : ''}${AUDIO_SCRIPT(muted, volume, href)}<base href="${href}">`;
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
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/fwd') return handleFwd(req, res, url);
    if (req.method === 'OPTIONS') return send(res, 204, '');
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
    if (url.pathname === '/epg')
        return getEpg()
            .then((data) => send(res, 200, JSON.stringify(data), { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' }))
            .catch(() => json(res, 200, { updatedAt: Date.now(), channels: {} }));
    if (m) return handleFile(req, res, m[1], m[2]);
    if (url.pathname.startsWith('/p/')) return handleFeed(req, res, url)
            .then((ok) => ok || send(res, 404, 'no existe'))
            .catch(() => send(res, 500, ''));
    if (handleStatic(req, res, url)) return;
    send(res, 404, 'no existe');
});

// Detener lo que nadie está viendo
setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastAccess > IDLE_MS) stopSession(id);
    stopIdleFeeds(IDLE_MS);
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
    warmEpg();
});
