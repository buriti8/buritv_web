/**
 * localStorage con JSON y a prueba de fallos (modo privado, almacenamiento
 * bloqueado…): si no se puede leer o escribir, la app sigue funcionando.
 */
const PREFIX = 'buritv:';

export function load(key, fallback = null) {
    try {
        const raw = window.localStorage.getItem(PREFIX + key);
        return raw == null ? fallback : JSON.parse(raw);
    } catch {
        return fallback;
    }
}

export function save(key, value) {
    try {
        window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {}
}
