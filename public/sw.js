/*
 * BuriTV: guarda la interfaz (HTML, JS, CSS, íconos) para que abra rápido
 * e instalada como app. Nunca guarda señales, la lista de canales ni la
 * retransmisión: eso siempre va a la red.
 */
const CACHE = 'buritv-shell-v1';

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './index.html', './manifest.webmanifest'])));
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    // Solo archivos propios de la app (mismo origen, GET)
    if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
    // La red primero; si no hay red, lo guardado
    e.respondWith(
        fetch(e.request)
            .then((res) => {
                if (res.ok) {
                    const copy = res.clone();
                    caches.open(CACHE).then((c) => c.put(e.request, copy));
                }
                return res;
            })
            .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))),
    );
});
