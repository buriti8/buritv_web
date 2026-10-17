import { useState, useRef, useCallback, useEffect } from 'react';

// Tras el último CH+/CH− o ↑/↓, espera esto antes de sintonizar: así al
// pasar rápido por varios canales solo se carga el último.
const ZAP_COMMIT_MS = 650;
// Tiempo para teclear el siguiente número ("1" … "2" = canal 12)
const DIGIT_WAIT_MS = 1500;
const OSD_MS = 2500;

/**
 * Cambio de canal "tipo decodificador" para TV.
 *
 *  - zapBy(±1): CH+/CH− o ↑/↓ en pantalla completa. Muestra al instante el
 *    canal destino y sintoniza cuando se deja de presionar.
 *  - typeDigit(d): números del control. Si ningún número más largo es
 *    posible (p. ej. "2" con 18 canales) sintoniza enseguida; si no, espera
 *    al siguiente dígito.
 *  - optionBy(±1): ←/→ en pantalla completa recorre las opciones del canal.
 *
 *  osd: lo que se muestra en pantalla mientras tanto.
 */
export default function useZapping({
    channels,
    currentIndex,
    sourceIndex,
    onSelectChannel,
    onSelectSource,
}) {
    const [osd, setOsd] = useState(null);
    const pendingChannel = useRef(null);
    const pendingOption = useRef(null);
    const digits = useRef('');
    const commitTimer = useRef(null);
    const hideTimer = useRef(null);

    const live = useRef({});
    live.current = { channels, currentIndex, sourceIndex, onSelectChannel, onSelectSource };

    const showOsd = useCallback((next, ms = OSD_MS) => {
        setOsd(next);
        clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setOsd(null), ms);
    }, []);

    const schedule = (ms, fn) => {
        clearTimeout(commitTimer.current);
        commitTimer.current = setTimeout(fn, ms);
    };

    const resetPending = () => {
        pendingChannel.current = null;
        pendingOption.current = null;
        digits.current = '';
    };

    const tuneTo = useCallback((idx) => {
        const ch = live.current.channels[idx];
        resetPending();
        if (ch) live.current.onSelectChannel(ch);
    }, []);

    const zapBy = useCallback(
        (delta) => {
            const { channels: list, currentIndex: cur } = live.current;
            if (!list.length) return;
            digits.current = '';
            pendingOption.current = null;
            const base = pendingChannel.current ?? Math.max(cur, 0);
            const next = (base + delta + list.length) % list.length;
            pendingChannel.current = next;
            showOsd({ kind: 'channel', index: next });
            schedule(ZAP_COMMIT_MS, () => tuneTo(next));
        },
        [showOsd, tuneTo],
    );

    const typeDigit = useCallback(
        (d) => {
            const list = live.current.channels;
            if (!list.length) return;
            pendingChannel.current = null;
            pendingOption.current = null;
            const maxLen = String(list.length).length;
            let typed = digits.current + d;
            if (typed.length > maxLen) typed = d; // empezar un número nuevo
            digits.current = typed;

            const n = parseInt(typed, 10);
            const valid = n >= 1 && n <= list.length;
            // ¿Podría un dígito más formar un canal válido?
            const complete = typed.length >= maxLen || n * 10 > list.length;

            showOsd({ kind: 'digits', digits: typed, maxLen, index: valid ? n - 1 : -1 }, DIGIT_WAIT_MS + OSD_MS);
            schedule(complete ? 350 : DIGIT_WAIT_MS, () => {
                digits.current = '';
                if (valid) {
                    showOsd({ kind: 'channel', index: n - 1 });
                    tuneTo(n - 1);
                } else {
                    showOsd({ kind: 'digits', digits: typed, maxLen, index: -1, invalid: true }, 1800);
                }
            });
        },
        [showOsd, tuneTo],
    );

    const optionBy = useCallback(
        (delta) => {
            const { channels: list, currentIndex: cur, sourceIndex: src } = live.current;
            const ch = list[cur];
            const count = ch?.sources.length ?? 0;
            if (count < 2) {
                showOsd({ kind: 'channel', index: cur });
                return;
            }
            pendingChannel.current = null;
            digits.current = '';
            const base = pendingOption.current ?? src;
            const next = (base + delta + count) % count;
            pendingOption.current = next;
            showOsd({ kind: 'option', index: cur, option: next, count });
            schedule(ZAP_COMMIT_MS, () => {
                pendingOption.current = null;
                live.current.onSelectSource(next);
            });
        },
        [showOsd],
    );

    // Mostrar el banner del canal actual (tecla Info)
    const showCurrent = useCallback(() => {
        showOsd({ kind: 'channel', index: live.current.currentIndex });
    }, [showOsd]);

    useEffect(
        () => () => {
            clearTimeout(commitTimer.current);
            clearTimeout(hideTimer.current);
        },
        [],
    );

    return { osd, zapBy, typeDigit, optionBy, showCurrent };
}
