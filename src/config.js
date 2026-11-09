// ── Lista de canales ─────────────────────────────────────────────────────
// Google Drive rechaza las descargas hechas desde una página (CORS / Sec-Fetch),
// así que la lista se pide al propio servidor de la web (/m3u, que atiende
// el relay en Docker) y, de respaldo, a la retransmisión por su puerto.
export const RELAY_PORT = 8090;
// En producción la web la sirve el propio relay: mismo origen (así funciona
// también detrás de un túnel HTTPS, que no expone el puerto 8090). En
// desarrollo (vite, puerto 5180) el relay está aparte en su puerto.
const DEV_SERVER = window.location.port === '5180';
export const RELAY_URL = DEV_SERVER
    ? `${window.location.protocol}//${window.location.hostname}:${RELAY_PORT}`
    : window.location.origin;
export const M3U_URLS = ['./m3u', `${RELAY_URL}/m3u`];
export const M3U_TIMEOUT_MS = 12000;
export const M3U_RETRY_MS = [3000, 8000, 15000, 30000];

// ── Qué partido está dando cada canal (FotMob, vía el relay) ─────────────
export const NOW_PLAYING_URLS = ['./now-playing', `${RELAY_URL}/now-playing`];
export const NOW_PLAYING_POLL_MS = 60000;

// ── Programación de cada canal (guías XMLTV, vía el relay) ────────────────
export const EPG_URLS = ['./epg', `${RELAY_URL}/epg`];
export const EPG_POLL_MS = 15 * 60 * 1000;
// Cada cuánto se recalcula "Ahora / Sigue" y la barra de progreso
export const EPG_TICK_MS = 30000;


// ── Diseño ───────────────────────────────────────────────────────────────
// Por debajo de este ancho: diseño de celular; por encima: el de TV
export const WIDE_MIN_PX = 820;

// ── Recuperación del stream (mismos valores que la app) ──────────────────
export const STALL_MS = 10000;
export const START_TIMEOUT_MS = 20000;
export const RETRY_BACKOFF_MS = [500, 2500];
export const FAILED_RETRY_MS = 20000;
export const WATCHDOG_MS = 2000;
export const FLAP_LIMIT = 3;
export const FLAP_WINDOW_MS = 60000;
// Una reconexión breve de la misma opción no se muestra
export const RECONNECT_GRACE_MS = 2500;
// Volver a la pestaña tras menos de esto: se retoma sin reconectar
export const RESUME_LIVE_MS = 10000;

// ── Internet lento (automático) ──────────────────────────────────────────
export const STALL_MS_SLOW = 20000;
export const START_TIMEOUT_MS_SLOW = 35000;
export const SLOW_MAX_BITRATE = 1500000;
export const BITRATE_STEPS = [2500000, 1200000, 600000];
export const SLOW_ON_STALLS = 2;
export const SLOW_STALL_WINDOW_MS = 5 * 60 * 1000;
export const SLOW_ON_BPS = 1800000;
export const SLOW_OFF_BPS = 4000000;
export const SLOW_OFF_AFTER_MS = 15 * 60 * 1000;
