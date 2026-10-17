/**
 * Parsea un archivo M3U y extrae canales + opciones VLC globales.
 *
 * Soporta:
 *  - #EXTVLCOPT globales (antes del primer #EXTINF)
 *  - #EXTVLCOPT por canal (entre #EXTINF y la URL)
 *  - tvg-logo, group-title
 *  - Canales web/embed (se reproducen en WebView en vez de VLC):
 *      · automático si la URL contiene /embed/ o termina en .html
 *      · explícito con tvg-type="web" en el #EXTINF, salvo que la URL sea
 *        un stream directo (.m3u8, .ts, .mpd…): un WebView no reproduce
 *        HLS y la señal quedaba trabada (pasaba con DSPORTS opción 1)
 *  - Varias fuentes por canal: las entradas con el mismo tvg-id, o con el
 *    mismo nombre sin el sufijo "(Opción N)", se agrupan en un solo canal
 *    con `sources` en el orden en que aparecen.
 */

const WEB_URL_RE = /\/embed\/|\.html?(\?|$)/i;
const STREAM_URL_RE = /\.(m3u8?|ts|mpd|mp4|flv)(\?|$)/i;
const OPTION_RE = /\s*[([]?\s*opci[oó]n\s*(\d+)\s*[)\]]?\s*$/i;

const slug = (s) =>
    s
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\+/g, ' plus')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

export default function parseM3U(data) {
    const lines = data.split('\n');
    const channels = [];
    const byId = new Map();
    const globalVlcOpts = [];
    let entry = null;
    let currentVlcOpts = [];
    let seenFirstExtinf = false;

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        if (line.startsWith('#EXTVLCOPT:')) {
            const opt = line.substring(11).trim();
            if (!seenFirstExtinf) {
                globalVlcOpts.push(opt);
            } else {
                currentVlcOpts.push(opt);
            }
        } else if (line.startsWith('#EXTINF')) {
            seenFirstExtinf = true;
            const attr = (name) => {
                const m = line.match(new RegExp(`${name}="([^"]*)"`, 'i'));
                return m ? m[1] : '';
            };
            const parts = line.split(',');
            entry = {
                name: parts[parts.length - 1]?.trim() || 'Sin nombre',
                id: attr('tvg-id'),
                logo: attr('tvg-logo'),
                group: attr('group-title'),
                type: attr('tvg-type').toLowerCase(),
            };
        } else if (!line.startsWith('#')) {
            const e = entry || { name: 'Sin nombre', id: '', logo: '', group: '', type: '' };
            const opt = e.name.match(OPTION_RE);
            const baseName = e.name.replace(OPTION_RE, '').trim() || e.name;
            const id = e.id || slug(baseName);

            let channel = byId.get(id);
            if (!channel) {
                channel = {
                    id,
                    name: baseName,
                    logo: e.logo,
                    group: e.group && e.group !== '-' ? e.group : '',
                    sources: [],
                };
                byId.set(id, channel);
                channels.push(channel);
            }
            if (!channel.logo && e.logo) channel.logo = e.logo;

            channel.sources.push({
                url: line,
                label: opt ? `Opción ${opt[1]}` : `Opción ${channel.sources.length + 1}`,
                type:
                    WEB_URL_RE.test(line) || (e.type === 'web' && !STREAM_URL_RE.test(line))
                        ? 'web'
                        : 'stream',
                vlcOpts: currentVlcOpts.length ? currentVlcOpts : null,
            });

            entry = null;
            currentVlcOpts = [];
        }
    }

    return {
        channels,
        globalVlcOpts: globalVlcOpts.map((o) => `--${o}`),
    };
}
