/**
 * BuriTV · qué partido está dando cada canal (datos de FotMob)
 *
 *  - Guía (tvguide?country=co): qué canales pasan cada partido. FotMob la
 *    cachea 1 h, así que se pide cada GUIDE_TTL_MS.
 *  - Estado (matches?date=…): en vivo / minuto / marcador / terminado, con
 *    caché de 10 s en FotMob. Se pide cada STATUS_TTL_MS y solo si hay algún
 *    partido de nuestros canales dentro de la ventana activa.
 *  - Se cruzan por id de partido. La tabla de equivalencias de canales está
 *    en channel-map.json (tvg-id → nombres en FotMob).
 *  - Todo es bajo demanda: si nadie abre la web, no se consulta nada.
 *    Si FotMob falla, se responde con lo último que se tenga (o vacío).
 */
import https from 'node:https';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const COUNTRY = process.env.TVGUIDE_COUNTRY || 'co';
const TIMEZONE = process.env.TZ || 'America/Bogota';
const BASE = 'https://www.fotmob.com/api/data';
const GUIDE_TTL_MS = 30 * 60 * 1000;
const STATUS_TTL_MS = 60 * 1000;
// Se muestra "Empieza HH:MM" desde este tiempo antes del inicio
const SOON_MS = 10 * 60 * 1000;
// Sin estado de FotMob: se da por terminado tras este tiempo desde el inicio
const FALLBACK_LENGTH_MS = 135 * 60 * 1000;
// Partidos que pueden estar activos: desde SOON_MS antes hasta un buen rato después
const WINDOW_AFTER_MS = 4 * 60 * 60 * 1000;
const MAP_FILE = fileURLToPath(new URL('./channel-map.json', import.meta.url));

// Sin tildes, mayúsculas, espacios ni signos (se conserva "+")
const norm = (s) =>
    String(s || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9+]/g, '');

// liveTime.short trae marcas de dirección invisibles (U+200E)
const clean = (s) => (s ? String(s).replace(/[‎‏‪-‮]/g, '').trim() : null);

let map = { mtime: 0, byName: new Map() };
function channelMap() {
    try {
        const mtime = statSync(MAP_FILE).mtimeMs;
        if (mtime !== map.mtime) {
            const raw = JSON.parse(readFileSync(MAP_FILE, 'utf8'));
            const byName = new Map();
            for (const [id, names] of Object.entries(raw)) {
                if (id.startsWith('_') || !Array.isArray(names)) continue;
                for (const n of names) {
                    const k = norm(n);
                    if (!byName.has(k)) byName.set(k, []);
                    byName.get(k).push(id);
                }
            }
            map = { mtime, byName };
        }
    } catch (e) {
        console.log(`[now-playing] channel-map.json: ${e.message}`);
    }
    return map.byName;
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        const r = https.get(
            url,
            { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (BuriTV)', Accept: 'application/json' } },
            (up) => {
                const chunks = [];
                up.on('data', (c) => chunks.push(c));
                up.on('end', () => {
                    if (up.statusCode !== 200) return reject(new Error(`HTTP ${up.statusCode}`));
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch (e) {
                        reject(e);
                    }
                });
                up.on('error', reject);
            },
        );
        r.on('timeout', () => r.destroy(new Error('timeout')));
        r.on('error', reject);
    });
}

// Fecha YYYYMMDD de un instante en una zona horaria
const dateKey = (ms, timeZone) => {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date(ms))
        .reduce((o, x) => ((o[x.type] = x.value), o), {});
    return `${p.year}${p.month}${p.day}`;
};

const state = {
    guide: [], // [{ id, start, home, away, league, channelIds }]
    guideAt: 0,
    status: new Map(), // matchId → { started, finished, cancelled, ongoing, score, minute }
    statusAt: 0,
    inflight: null,
};
const unmapped = new Set();

async function refreshGuide() {
    // FotMob arma los días de la guía según la fecha UTC: con timezone de
    // Bogotá, desde las 7 p. m. (00:00 UTC) se pierden los partidos de esa
    // noche. Sin timezone sí vienen. Se piden ambas y se unen por id.
    const results = await Promise.allSettled([
        getJson(`${BASE}/tvguide?country=${COUNTRY}`),
        getJson(`${BASE}/tvguide?country=${COUNTRY}&timezone=${encodeURIComponent(TIMEZONE)}`),
    ]);
    const datas = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!datas.length) throw results[0].reason;
    const byName = channelMap();
    const guide = [];
    const fresh = [];
    const seen = new Set();
    for (const leagues of datas.flatMap((d) => Object.values(d || {}))) {
        if (!Array.isArray(leagues)) continue;
        for (const L of leagues) {
            for (const m of L.matches || []) {
                if (seen.has(m.id)) continue;
                seen.add(m.id);
                const channelIds = new Set();
                for (const c of m.channels || []) {
                    const ids = byName.get(norm(c.name));
                    if (ids) ids.forEach((id) => channelIds.add(id));
                    else if (!unmapped.has(c.name)) {
                        unmapped.add(c.name);
                        fresh.push(c.name);
                    }
                }
                if (!channelIds.size) continue;
                guide.push({
                    id: m.id,
                    start: Date.parse(m.utcTime),
                    home: m.home?.shortName || m.home?.name || '',
                    away: m.away?.shortName || m.away?.name || '',
                    league: m.leagueName || L.leagueName || '',
                    channelIds: [...channelIds],
                });
            }
        }
    }
    // Para ir completando channel-map.json si FotMob agrega canales
    if (fresh.length) console.log(`[now-playing] canales de FotMob sin equivalencia: ${fresh.join(', ')}`);
    state.guide = guide;
    state.guideAt = Date.now();
}

// Partidos que pueden estar en pantalla ahora
const activeCandidates = (now) =>
    state.guide.filter((m) => now >= m.start - SOON_MS && now <= m.start + WINDOW_AFTER_MS);

async function refreshStatus(candidates) {
    const wanted = new Set(candidates.map((m) => m.id));
    const dates = new Set();
    for (const m of candidates) {
        dates.add(dateKey(m.start, TIMEZONE));
        dates.add(dateKey(m.start, 'UTC'));
    }
    const status = new Map();
    let ok = false;
    for (const d of dates) {
        try {
            const data = await getJson(`${BASE}/matches?date=${d}&timezone=${encodeURIComponent(TIMEZONE)}`);
            ok = true;
            for (const L of data?.leagues || []) {
                for (const m of L.matches || []) {
                    if (!wanted.has(m.id) || status.has(m.id)) continue;
                    const s = m.status || {};
                    status.set(m.id, {
                        started: !!s.started,
                        finished: !!s.finished,
                        cancelled: !!s.cancelled,
                        ongoing: !!s.ongoing,
                        score: s.scoreStr || (s.started ? `${m.home?.score ?? 0} - ${m.away?.score ?? 0}` : null),
                        minute: clean(s.liveTime?.short),
                    });
                }
            }
        } catch (e) {
            console.log(`[now-playing] estado ${d}: ${e.message}`);
        }
    }
    if (!ok) throw new Error('sin estado');
    state.status = status;
    state.statusAt = Date.now();
}

async function refresh() {
    const now = Date.now();
    if (now - state.guideAt > GUIDE_TTL_MS) {
        try {
            await refreshGuide();
        } catch (e) {
            console.log(`[now-playing] guía: ${e.message}`);
            // Reintentar en unos minutos, no en cada pedido
            state.guideAt = now - GUIDE_TTL_MS + 5 * 60 * 1000;
        }
    }
    const candidates = activeCandidates(now);
    if (candidates.length && now - state.statusAt > STATUS_TTL_MS) {
        try {
            await refreshStatus(candidates);
        } catch {
            state.statusAt = now - STATUS_TTL_MS + 30 * 1000;
        }
    }
}

/** Qué es cada partido ahora: 'live' | 'soon' | null (no mostrar). */
function classify(m, now) {
    const s = state.status.get(m.id);
    if (s) {
        if (s.finished || s.cancelled) return null;
        if (s.ongoing || s.started) return 'live';
        return now >= m.start - SOON_MS ? 'soon' : null;
    }
    // Sin estado (FotMob no lo trajo): se estima por la hora
    if (now < m.start - SOON_MS || now > m.start + FALLBACK_LENGTH_MS) return null;
    return now < m.start ? 'soon' : 'live';
}

function build(now) {
    const perChannel = new Map();
    for (const m of activeCandidates(now)) {
        const kind = classify(m, now);
        if (!kind) continue;
        for (const id of m.channelIds) {
            if (!perChannel.has(id)) perChannel.set(id, []);
            perChannel.get(id).push({ m, kind });
        }
    }
    const channels = {};
    for (const [id, list] of perChannel) {
        // Gana el que está en vivo; entre dos en vivo, el que empezó primero
        // (el canal suele terminar el partido antes de pasar al siguiente)
        list.sort((a, b) => (a.kind === b.kind ? a.m.start - b.m.start : a.kind === 'live' ? -1 : 1));
        const { m, kind } = list[0];
        const s = state.status.get(m.id);
        channels[id] = {
            matchId: m.id,
            home: m.home,
            away: m.away,
            league: m.league,
            state: kind,
            score: kind === 'live' ? s?.score ?? null : null,
            minute: kind === 'live' ? s?.minute ?? null : null,
            startsAt: new Date(m.start).toISOString(),
        };
    }
    return channels;
}

export async function getNowPlaying() {
    if (!state.inflight) state.inflight = refresh().finally(() => (state.inflight = null));
    // Primera vez: se espera. Después se responde ya con lo que hay y se
    // actualiza por detrás (el pedido siguiente trae lo nuevo)
    if (!state.guideAt) await state.inflight;
    const now = Date.now();
    return { updatedAt: now, channels: build(now) };
}
