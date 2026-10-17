import { useEffect, useRef, useState } from 'react';
import { canEmbed, relayAvailable, relayPageUrl } from '../lib/relay';
import Icon from './Icon';

/**
 * Embeds web (Kick, YouTube, Twitch…) en un iframe.
 *  - Twitch exige el dominio de esta página en `parent`: se reescribe solo.
 *  - YouTube "watch" se pasa a su versión embebible.
 *  - Las páginas que prohíben mostrarse dentro de otra (X-Frame-Options)
 *    no se pueden ver aquí: si hay otras opciones se pasa a la siguiente;
 *    si no, se ofrece abrirla en una pestaña nueva.
 */
export function embedUrl(raw, muted = false) {
    try {
        const u = new URL(raw);
        const host = u.hostname.replace(/^www\./, '');
        if (host === 'player.twitch.tv') {
            u.searchParams.delete('parent');
            u.searchParams.append('parent', window.location.hostname);
            u.searchParams.set('autoplay', 'true');
            u.searchParams.set('muted', String(muted));
            return u.toString();
        }
        if (host === 'youtube.com' || host === 'm.youtube.com') {
            const id = u.searchParams.get('v');
            if (id) return `https://www.youtube.com/embed/${id}?autoplay=1&playsinline=1&enablejsapi=1&mute=${muted ? 1 : 0}`;
        }
        if (host === 'youtu.be') {
            return `https://www.youtube.com/embed${u.pathname}?autoplay=1&playsinline=1&enablejsapi=1&mute=${muted ? 1 : 0}`;
        }
        if (host === 'player.kick.com') {
            u.searchParams.set('muted', String(muted));
            u.searchParams.set('autoplay', 'true');
            return u.toString();
        }
        return raw;
    } catch {
        return raw;
    }
}

// YouTube se silencia al instante por mensaje; el resto recarga con el parámetro "muted"
const isYouTube = (url) => /(^|.)(youtube.com|youtu.be)$/.test(new URL(url, location.href).hostname);

export default function WebEmbed({
    url,
    muted: mutedProp = false,
    volume = 1,
    hasAlternatives,
    onLoaded,
    onFail,
    onAutoplayBlocked,
}) {
    const [allowed, setAllowed] = useState(null);
    const frameRef = useRef(null);
    const yt = isYouTube(url);
    // Sin ningún gesto previo del usuario el navegador no deja sonar un iframe:
    // arranca silenciado y el primer toque lo recarga con sonido.
    const needsGesture = !(navigator.userActivation?.hasBeenActive ?? true);
    const muted = mutedProp || needsGesture;
    // Páginas con reproductor propio: pasan por la retransmisión, que toma el
    // control de su audio (si no está encendida, se muestran tal cual).
    const proxied = !yt && embedUrl(url) === url && relayAvailable();
    const proxySrc = useRef(null);
    if (!proxied) proxySrc.current = null;
    else if (!proxySrc.current) proxySrc.current = relayPageUrl(url, muted, volume);

    useEffect(() => {
        if (!proxied) return;
        const send = () =>
            frameRef.current?.contentWindow?.postMessage({ buritv: 'audio', muted, volume }, '*');
        send();
        const t = setTimeout(send, 1500);
        return () => clearTimeout(t);
    }, [proxied, muted, volume, allowed]);

    useEffect(() => {
        if (needsGesture) onAutoplayBlocked?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [needsGesture, url]);

    useEffect(() => {
        if (!yt) return;
        const post = (func, args = []) =>
            frameRef.current?.contentWindow?.postMessage(
                JSON.stringify({ event: 'command', func, args }),
                '*',
            );
        const send = () => {
            post('setVolume', [Math.round(volume * 100)]);
            post(muted ? 'mute' : 'unMute');
        };
        send();
        const t = setTimeout(send, 1500);
        return () => clearTimeout(t);
    }, [muted, volume, yt, allowed]);

    useEffect(() => {
        let cancelled = false;
        canEmbed(url).then((ok) => {
            if (cancelled) return;
            setAllowed(ok);
            if (!ok) {
                if (hasAlternatives) onFail?.('error', { dead: true, detail: 'no embebible' });
                else onLoaded?.();
            }
        });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url]);

    if (allowed === null) return null;
    if (!allowed) {
        return (
            <div className="status status-dark">
                <p className="status-title">Esta opción solo se puede ver en su página</p>
                <a className="btn-tonal" href={url} target="_blank" rel="noreferrer">
                    <Icon name="external" size={14} /> Abrir en una pestaña nueva
                </a>
            </div>
        );
    }
    return (
        <iframe
            key={yt ? 'yt' : proxied ? 'page' : String(muted)}
            ref={frameRef}
            className="video"
            src={proxied ? proxySrc.current : embedUrl(url, muted)}
            title="Reproductor"
            tabIndex={-1}
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            allowFullScreen
            referrerPolicy="no-referrer-when-downgrade"
            onLoad={() => {
                onLoaded?.();
                if (yt) frameRef.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening' }), '*');
                if (proxied)
                    frameRef.current?.contentWindow?.postMessage({ buritv: 'audio', muted, volume }, '*');
            }}
        />
    );
}
