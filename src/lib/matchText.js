const timeFmt = new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' });

// FotMob usa "HT" para el entretiempo
const minuteText = (m) => (m === 'HT' ? 'ET' : m);

/** "Man United 1-2 Aston Villa · 35’" o "Celta Vigo vs Levante · 12:30 p. m." */
export function matchText(match) {
    if (!match) return null;
    if (match.state === 'soon') {
        return `${match.home} vs ${match.away} · ${timeFmt.format(new Date(match.startsAt))}`;
    }
    const score = match.score ? match.score.replace(/\s*-\s*/, '-') : 'vs';
    return [`${match.home} ${score} ${match.away}`, minuteText(match.minute)].filter(Boolean).join(' · ');
}

/** Para leer en voz alta o en el title: incluye la liga. */
export function matchTitle(match) {
    if (!match) return undefined;
    const when = match.state === 'soon' ? 'Empieza pronto' : 'En vivo';
    return `${when}: ${matchText(match)} (${match.league})`;
}
