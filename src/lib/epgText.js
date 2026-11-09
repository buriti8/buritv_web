const timeFmt = new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' });
const hour = (ms) => timeFmt.format(new Date(ms));

/** Lo que está dando el canal según la guía: "SportsCenter" (o "A las 8:00 p. m.: …" si aún no empieza). */
export function epgNowText(e) {
    if (!e) return null;
    if (e.now) return e.now.title;
    if (e.next) return `${hour(e.next.start)}: ${e.next.title}`;
    return null;
}

/** El siguiente programa: "Sigue 8:00 p. m.: LaLiga". */
export function epgNextText(e) {
    if (!e?.now || !e.next) return null;
    return `Sigue ${hour(e.next.start)}: ${e.next.title}`;
}

/** Para el title: horario completo del actual y el siguiente. */
export function epgTitle(e) {
    if (!e) return undefined;
    const lines = [];
    if (e.now) lines.push(`Ahora (${hour(e.now.start)} – ${hour(e.now.stop)}): ${e.now.title}`);
    if (e.next) lines.push(`${e.now ? 'Sigue' : 'Empieza'} ${hour(e.next.start)}: ${e.next.title}`);
    return lines.join('\n') || undefined;
}
