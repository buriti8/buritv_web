/**
 * BuriTV · peticiones HTTP(S) del relay a servicios de afuera (guías, streamers).
 */
import http from 'node:http';
import https from 'node:https';

export const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

/**
 * Cuerpo de la respuesta (Buffer); sigue redirecciones. Si no es 200, falla
 * con un error que trae `status`.
 */
export function request(url, { method = 'GET', headers = {}, body, timeout = 30000 } = {}, hops = 0) {
    return new Promise((resolve, reject) => {
        const data = body == null ? null : Buffer.from(typeof body === 'string' ? body : String(body));
        const lib = url.startsWith('https:') ? https : http;
        const r = lib.request(
            url,
            {
                method,
                timeout,
                headers: { 'User-Agent': BROWSER_UA, ...headers, ...(data ? { 'Content-Length': data.length } : {}) },
            },
            (up) => {
                if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location && hops < 5) {
                    up.resume();
                    return resolve(request(new URL(up.headers.location, url).toString(), { headers, timeout }, hops + 1));
                }
                if (up.statusCode !== 200) {
                    up.resume();
                    return reject(Object.assign(new Error(`HTTP ${up.statusCode}`), { status: up.statusCode }));
                }
                const chunks = [];
                up.on('data', (c) => chunks.push(c));
                up.on('end', () => resolve(Buffer.concat(chunks)));
                up.on('error', reject);
            },
        );
        r.on('timeout', () => r.destroy(new Error('timeout')));
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}

export const requestText = async (url, opts) => (await request(url, opts)).toString('utf8');
export const requestJson = async (url, opts) => JSON.parse(await requestText(url, opts));
