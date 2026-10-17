/**
 * Chromecast (SDK de emisor de Google). Solo hay en navegadores Chromium
 * (Chrome, Edge, Opera) y en páginas https o localhost. En otros, el botón
 * no aparece.
 */
const SDK = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';

let loading = null;

/** Carga el SDK una sola vez. Resuelve true si se puede transmitir desde este navegador. */
export function loadCast() {
    if (loading) return loading;
    loading = new Promise((resolve) => {
        window.__onGCastApiAvailable = (ok) => {
            if (!ok) return resolve(false);
            try {
                cast.framework.CastContext.getInstance().setOptions({
                    receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
                    autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
                });
                resolve(true);
            } catch {
                resolve(false);
            }
        };
        const s = document.createElement('script');
        s.src = SDK;
        s.async = true;
        s.onerror = () => resolve(false);
        document.head.appendChild(s);
    });
    return loading;
}
