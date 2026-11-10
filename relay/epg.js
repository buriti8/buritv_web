/**
 * BuriTV · programación de cada canal
 *
 *  Fuentes (epg-map.json dice cuáles usa cada canal, en orden de preferencia):
 *   - movistar: guía de Movistar TV Colombia (API JSON, todos los canales en
 *     una sola petición).
 *   - claro: guía de Claro Colombia (devportal.siba.com.co, una petición por
 *     canal). Trae Caracol, que Movistar no tiene.
 *   - tapkit: guía de Warner (TNT Sports), una petición por señal.
 *   - xmltv: archivos diarios de epgshare01.online, para lo que no está en
 *     ninguna de las anteriores (DSports, TyC).
 *
 *  - Todo es bajo demanda, como /now-playing: se consulta cuando alguien pide
 *    /epg y lo que se tiene tiene más de LIVE_TTL_MS (los XMLTV, XMLTV_TTL_MS).
 *  - Se va de fuente en fuente: a la siguiente solo se le pregunta por los
 *    canales que las anteriores no trajeron.
 *  - Si una fuente falla, se conserva lo último que dio y se reintenta tras
 *    RETRY_MS.
 *
 * GET /epg → { updatedAt, channels: { <tvg-id>: [{ start, stop, title }] } }
 * (start/stop en milisegundos; ordenados por inicio)
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { request, requestJson } from './http.js';

const LIVE_TTL_MS = 10 * 60 * 1000;
const XMLTV_TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;
const KEEP_BEFORE_MS = 3 * 60 * 60 * 1000;
const KEEP_AFTER_MS = 30 * 60 * 60 * 1000;
const MAP_FILE = fileURLToPath(new URL('./epg-map.json', import.meta.url));

const MOVISTAR_URL = 'https://contentapi-co.cdn.telefonica.com/33/default/es-CO/schedules';
const MOVISTAR_PAGE = 1000;
const CLARO_URL = 'http://devportal.siba.com.co/index.php?action=grilla';
const TAPKIT_URL = 'https://epg.tapkit.warnermedia.com/cloud-epg-schedule/schedule-sports';
const xmltvUrl = (file) => `https://epgshare01.online/epgshare01/epg_ripper_${file}.xml.gz`;

/** { tvg-id: [{ type, id, file? }] } */
function loadMap() {
    try {
        const raw = JSON.parse(readFileSync(MAP_FILE, 'utf8'));
        const map = {};
        for (const [tvgId, list] of Object.entries(raw)) {
            if (tvgId.startsWith('_') || !Array.isArray(list)) continue;
            map[tvgId] = list
                .map((s) => {
                    const [type, ...rest] = String(s).split(':');
                    if (type === 'movistar' || type === 'claro' || type === 'tapkit')
                        return rest[0] ? { type, id: rest.join(':') } : null;
                    if (type === 'xmltv' && rest.length >= 2) return { type, file: rest[0], id: rest.slice(1).join(':') };
                    return null;
                })
                .filter(Boolean);
        }
        return map;
    } catch (e) {
        console.log(`[epg] no se pudo leer epg-map.json: ${e.message}`);
        return {};
    }
}

const windowNow = () => ({ from: Date.now() - KEEP_BEFORE_MS, to: Date.now() + KEEP_AFTER_MS });

/** Deja lo de la ventana, sin repetidos y ordenado por inicio. */
function tidy(list, { from, to }) {
    const seen = new Set();
    const out = [];
    for (const p of list) {
        if (!(p.title && p.stop > p.start && p.stop > from && p.start < to) || seen.has(p.start)) continue;
        seen.add(p.start);
        out.push(p);
    }
    return out.sort((a, b) => a.start - b.start);
}

// ── Movistar ──

/** { LCH…: programas } de los canales pedidos (los que no salen, con []). */
async function fetchMovistar(pids) {
    const win = windowNow();
    const params = new URLSearchParams({
        ca_deviceTypes: 'null|401',
        ca_channelmaps: '166|null',
        fields: 'Title,LiveChannelPid,Start,End',
        orderBy: 'START_TIME:a',
        filteravailability: 'false',
        starttime: String(Math.floor(win.from / 1000)),
        endtime: String(Math.floor(win.to / 1000)),
        livechannelpids: pids.join(','),
        limit: String(MOVISTAR_PAGE),
    });
    const byPid = Object.fromEntries(pids.map((p) => [p, []]));
    for (let offset = 0; ; offset += MOVISTAR_PAGE) {
        params.set('offset', String(offset));
        const data = await requestJson(`${MOVISTAR_URL}?${params}`);
        const list = Array.isArray(data?.Content) ? data.Content : data?.Content?.List;
        if (!Array.isArray(list)) throw new Error('respuesta inesperada');
        for (const p of list) {
            byPid[p.LiveChannelPid]?.push({ start: p.Start * 1000, stop: p.End * 1000, title: String(p.Title || '').trim() });
        }
        if (list.length < MOVISTAR_PAGE) break;
    }
    for (const pid of pids) byPid[pid] = tidy(byPid[pid], win);
    return byPid;
}

// ── Claro ──

async function fetchClaro(id) {
    const win = windowNow();
    const body = new URLSearchParams({
        servicio: '9',
        ini: String(Math.floor(win.from / 1000)),
        end: String(Math.floor(win.to / 1000)),
        chn: id,
    });
    const data = await requestJson(CLARO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body,
    });
    if (!Array.isArray(data?.list)) throw new Error('respuesta inesperada');
    const ch = data.list.find((c) => String(c.id) === id);
    const list = (ch?.prog || []).map((p) => ({ start: p.ini * 1000, stop: p.fin * 1000, title: String(p.nom || '').trim() }));
    return tidy(list, win);
}

// ── Warner (TNT Sports) ──

const dayIn = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms)); // YYYY-MM-DD

async function fetchTapkit(feed) {
    const win = windowNow();
    const tz = 'America/Argentina/Buenos_Aires';
    const params = new URLSearchParams({ feed, from: dayIn(win.from, tz), to: dayIn(win.to, tz) });
    const data = await requestJson(`${TAPKIT_URL}?${params}`);
    const dto = data?.['com.turner.dmtla.schedule.dto.ScheduleDTO'];
    if (!Array.isArray(dto?.feeds)) throw new Error('respuesta inesperada');
    // Las horas vienen sin zona; la del día viene aparte ("-03:00")
    const offset = /^[+-]\d\d:\d\d$/.test(dto.offset || '') ? dto.offset : '-03:00';
    const shows = dto.feeds.find((f) => f.code === feed)?.shows || [];
    const list = shows.map((s) => {
        let title = String(s.originalTitle || '').trim() || String(s.title || '').trim();
        const franchise = String(s.franchiseName || '');
        if (/REPETICI/i.test(franchise)) title += ' (repetición)';
        else if (/DIFERIDO/i.test(franchise)) title += ' (diferido)';
        return { start: Date.parse(`${s.begin}${offset}`), stop: Date.parse(`${s.end}${offset}`), title };
    });
    return tidy(list, win);
}

// ── XMLTV ──

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

/** Todos los programas del archivo dentro de la ventana: { canal: programas } */
function parseXmltv(xml) {
    const win = windowNow();
    const out = {};
    const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
    let m;
    while ((m = re.exec(xml))) {
        const attrs = m[1];
        const chm = /channel="([^"]*)"/.exec(attrs);
        if (!chm) continue;
        const start = xmltvTime((/start="([^"]*)"/.exec(attrs) || [])[1] || '');
        const stop = xmltvTime((/stop="([^"]*)"/.exec(attrs) || [])[1] || '');
        if (!(stop > win.from && start < win.to)) continue;
        const title = unescape(((/<title[^>]*>([\s\S]*?)<\/title>/.exec(m[2]) || [])[1] || '').trim());
        (out[unescape(chm[1])] ||= []).push({ start, stop, title });
    }
    for (const ch of Object.keys(out)) out[ch] = tidy(out[ch], win);
    return out;
}

async function fetchXmltv(file) {
    const buf = await request(xmltvUrl(file));
    // Si el servidor ya lo mandó descomprimido, se usa tal cual
    const xml = (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8');
    // Un aviso en HTML (límite de descargas, archivo que no existe…) no es una guía
    if (!/<tv[\s>]/.test(xml.slice(0, 4096))) throw new Error('no es un XMLTV');
    return parseXmltv(xml);
}

// ── Caché por fuente ──
// clave ("movistar:LCH2722", "claro:988", "xmltv:CO1") → { at, data }
// `at` es cuándo se pidió; si falló, se adelanta para reintentar a los RETRY_MS.

const cache = new Map();
const fresh = (key, ttl) => {
    const c = cache.get(key);
    return c && Date.now() - c.at < ttl;
};
const failed = (key, ttl) => {
    const c = cache.get(key);
    cache.set(key, { at: Date.now() - ttl + RETRY_MS, data: c?.data });
};

async function ensure(entries) {
    const jobs = [];

    const pids = [...new Set(entries.filter((e) => e.type === 'movistar').map((e) => e.id))].filter(
        (id) => !fresh(`movistar:${id}`, LIVE_TTL_MS),
    );
    if (pids.length)
        jobs.push(
            fetchMovistar(pids)
                .then((byPid) => pids.forEach((id) => cache.set(`movistar:${id}`, { at: Date.now(), data: byPid[id] })))
                .catch((e) => {
                    console.log(`[epg] movistar: ${e.message}`);
                    pids.forEach((id) => failed(`movistar:${id}`, LIVE_TTL_MS));
                }),
        );

    // Una petición por canal
    const single = { claro: fetchClaro, tapkit: fetchTapkit };
    for (const [type, fetchOne] of Object.entries(single)) {
        for (const id of new Set(entries.filter((e) => e.type === type).map((e) => e.id))) {
            const key = `${type}:${id}`;
            if (fresh(key, LIVE_TTL_MS)) continue;
            jobs.push(
                fetchOne(id)
                    .then((data) => cache.set(key, { at: Date.now(), data }))
                    .catch((e) => {
                        console.log(`[epg] ${type} ${id}: ${e.message}`);
                        failed(key, LIVE_TTL_MS);
                    }),
            );
        }
    }

    for (const file of new Set(entries.filter((e) => e.type === 'xmltv').map((e) => e.file))) {
        const key = `xmltv:${file}`;
        if (fresh(key, XMLTV_TTL_MS)) continue;
        jobs.push(
            fetchXmltv(file)
                .then((data) => cache.set(key, { at: Date.now(), data }))
                .catch((e) => {
                    console.log(`[epg] xmltv ${file}: ${e.message}`);
                    failed(key, XMLTV_TTL_MS);
                }),
        );
    }

    await Promise.all(jobs);
}

function programsOf(entry) {
    const c = entry.type === 'xmltv' ? cache.get(`xmltv:${entry.file}`)?.data?.[entry.id] : cache.get(`${entry.type}:${entry.id}`)?.data;
    const now = Date.now();
    return Array.isArray(c) && c.some((p) => p.stop > now) ? c : null;
}

// ── Armado ──

let state = { updatedAt: 0, channels: {} };
let loading = null;
let lastSummary = '';

async function refresh() {
    const map = loadMap();
    const channels = {};
    const used = {};
    let pending = Object.keys(map);
    for (let level = 0; pending.length; level++) {
        const entries = pending.map((id) => map[id][level]).filter(Boolean);
        if (!entries.length) break;
        await ensure(entries);
        pending = pending.filter((id) => {
            const entry = map[id][level];
            const list = entry && programsOf(entry);
            if (!list) return true;
            channels[id] = list;
            used[entry.type] = (used[entry.type] || 0) + 1;
            return false;
        });
    }

    // Sin nada nuevo para un canal: lo anterior, mientras le quede programación
    const missing = [];
    for (const id of pending) {
        if (state.channels[id]?.some((p) => p.stop > Date.now())) channels[id] = state.channels[id];
        else missing.push(id);
    }
    state = { updatedAt: Date.now(), channels };

    const summary =
        `${Object.keys(channels).length} canales con programación (` +
        Object.entries(used)
            .map(([t, n]) => `${t} ${n}`)
            .join(', ') +
        ')' +
        (missing.length ? `; sin programación: ${missing.join(', ')}` : '');
    if (summary !== lastSummary) console.log(`[epg] ${summary}`);
    lastSummary = summary;
}

function load() {
    if (loading) return loading;
    loading = refresh()
        .catch((e) => console.log(`[epg] ${e.message}`))
        .finally(() => {
            loading = null;
        });
    return loading;
}

/** Pide la programación al arrancar (sin esperar). */
export function warmEpg() {
    load();
}

/** La programación (solo de ahora en adelante, para no mandar lo que ya pasó). */
export async function getEpg() {
    if (Date.now() - state.updatedAt >= LIVE_TTL_MS) {
        const p = load();
        // La primera vez se espera; después se responde con lo que hay y se actualiza por detrás
        if (!state.updatedAt) await p;
    }
    const now = Date.now();
    const channels = {};
    for (const [id, list] of Object.entries(state.channels)) {
        const upcoming = list.filter((p) => p.stop > now);
        if (upcoming.length) channels[id] = upcoming;
    }
    return { updatedAt: state.updatedAt, channels };
}
