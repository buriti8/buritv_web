/**
 * BuriTV · programación de cada canal (guías XMLTV de open-epg.com)
 *
 *  - Se bajan las guías que nombra epg-map.json al arrancar y cada
 *    REFRESH_MS. Cada una pesa varios MB, así que se guarda solo lo de
 *    nuestros canales y entre KEEP_BEFORE_MS atrás y KEEP_AFTER_MS adelante.
 *  - Por canal se usa la primera fuente del mapa que traiga programas.
 *  - Si una descarga falla, se conserva lo último que se tenía.
 *
 * GET /epg → { updatedAt, channels: { <tvg-id>: [{ start, stop, title }] } }
 * (start/stop en milisegundos; ordenados por inicio)
 */
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const KEEP_BEFORE_MS = 3 * 60 * 60 * 1000;
const KEEP_AFTER_MS = 30 * 60 * 60 * 1000;
const MAP_FILE = fileURLToPath(new URL('./epg-map.json', import.meta.url));
const sourceUrl = (name) => `https://www.open-epg.com/files/${name}.xml`;

function loadMap() {
    try {
        const raw = JSON.parse(readFileSync(MAP_FILE, 'utf8'));
        const map = {};
        for (const [id, list] of Object.entries(raw)) {
            if (id.startsWith('_') || !Array.isArray(list)) continue;
            map[id] = list
                .map((s) => {
                    const i = s.indexOf(':');
                    return i > 0 ? { source: s.slice(0, i), channel: s.slice(i + 1) } : null;
                })
                .filter(Boolean);
        }
        return map;
    } catch (e) {
        console.log(`[epg] no se pudo leer epg-map.json: ${e.message}`);
        return {};
    }
}

function getText(url, hops = 0) {
    return new Promise((resolve, reject) => {
        const r = https.get(url, { timeout: 60000, headers: { 'User-Agent': 'BuriTV/1.0' } }, (up) => {
            if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location && hops < 5) {
                up.resume();
                return resolve(getText(new URL(up.headers.location, url).toString(), hops + 1));
            }
            if (up.statusCode !== 200) {
                up.resume();
                return reject(new Error(`HTTP ${up.statusCode}`));
            }
            const chunks = [];
            up.on('data', (c) => chunks.push(c));
            up.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            up.on('error', reject);
        });
        r.on('timeout', () => r.destroy(new Error('timeout')));
        r.on('error', reject);
    });
}

const unescape = (s) =>
    s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&amp;/g, '&');

// "20261108030000 +0000" → milisegundos
function xmltvTime(s) {
    const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?\s*(?:([+-])(\d\d)(\d\d))?/.exec(s);
    if (!m) return NaN;
    const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    const offset = m[7] ? (m[7] === '-' ? -1 : 1) * (+m[8] * 60 + +m[9]) : 0;
    return utc - offset * 60000;
}

/** Programas de los canales pedidos: { canal: [{ start, stop, title }] } */
function parseGuide(xml, wanted) {
    const out = {};
    const from = Date.now() - KEEP_BEFORE_MS;
    const to = Date.now() + KEEP_AFTER_MS;
    const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
    let m;
    while ((m = re.exec(xml))) {
        const attrs = m[1];
        const chm = /channel="([^"]*)"/.exec(attrs);
        if (!chm) continue;
        const channel = unescape(chm[1]);
        if (!wanted.has(channel)) continue;
        const start = xmltvTime((/start="([^"]*)"/.exec(attrs) || [])[1] || '');
        const stop = xmltvTime((/stop="([^"]*)"/.exec(attrs) || [])[1] || '');
        if (!(stop > from && start < to && stop > start)) continue;
        const title = unescape(((/<title[^>]*>([\s\S]*?)<\/title>/.exec(m[2]) || [])[1] || '').trim());
        if (!title) continue;
        const list = (out[channel] ||= []);
        // Algunas guías repiten cada programa
        if (!list.some((p) => p.start === start)) list.push({ start, stop, title });
    }
    for (const list of Object.values(out)) list.sort((a, b) => a.start - b.start);
    return out;
}

let state = { updatedAt: 0, channels: {} };
let loading = null;
let timer = null;

async function refresh() {
    const map = loadMap();
    const bySource = new Map(); // fuente → Set(canales del XML)
    for (const list of Object.values(map)) {
        for (const { source, channel } of list) {
            if (!bySource.has(source)) bySource.set(source, new Set());
            bySource.get(source).add(channel);
        }
    }
    const guides = {}; // fuente → { canal: programas }
    await Promise.all(
        [...bySource].map(async ([source, wanted]) => {
            try {
                guides[source] = parseGuide(await getText(sourceUrl(source)), wanted);
            } catch (e) {
                console.log(`[epg] ${source}: ${e.message}`);
            }
        }),
    );
    if (!Object.keys(guides).length) throw new Error('ninguna guía respondió');

    const channels = {};
    const missing = [];
    for (const [id, list] of Object.entries(map)) {
        const hit = list.map(({ source, channel }) => guides[source]?.[channel]).find((p) => p?.length);
        // Sin guía nueva para este canal: lo anterior, si lo había
        if (hit) channels[id] = hit;
        else if (state.channels[id]) channels[id] = state.channels[id];
        else missing.push(id);
    }
    state = { updatedAt: Date.now(), channels };
    console.log(
        `[epg] ${Object.keys(channels).length} canales con programación` +
            (missing.length ? `; sin programación: ${missing.join(', ')}` : ''),
    );
}

function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(load, ms);
    timer.unref?.();
}

function load() {
    if (loading) return loading;
    loading = refresh()
        .then(() => schedule(REFRESH_MS))
        .catch((e) => {
            console.log(`[epg] ${e.message}`);
            schedule(RETRY_MS);
        })
        .finally(() => {
            loading = null;
        });
    return loading;
}

/** Descarga las guías al arrancar (sin esperar). */
export function warmEpg() {
    load();
}

/** La programación (solo de ahora en adelante, para no mandar lo que ya pasó). */
export async function getEpg() {
    if (!state.updatedAt && loading) await loading;
    const now = Date.now();
    const channels = {};
    for (const [id, list] of Object.entries(state.channels)) {
        const upcoming = list.filter((p) => p.stop > now);
        if (upcoming.length) channels[id] = upcoming;
    }
    return { updatedAt: state.updatedAt, channels };
}
