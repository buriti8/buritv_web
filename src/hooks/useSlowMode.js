import { useState, useCallback, useEffect, useRef } from 'react';
import {
    SLOW_ON_STALLS,
    SLOW_STALL_WINDOW_MS,
    SLOW_ON_BPS,
    SLOW_OFF_BPS,
    SLOW_OFF_AFTER_MS,
} from '../config';
import { load, save } from '../lib/storage';

const K_SLOW = 'slowNetMode';
const MIN_BW_SAMPLES = 6;
const BW_ALPHA = 0.25;
const OFF_WITHOUT_DATA_MS = SLOW_OFF_AFTER_MS * 3;

/**
 * Modo "internet lento", automático e invisible (igual que en la app):
 *  - Se activa si una señal que ya sonaba se corta SLOW_ON_STALLS veces en
 *    SLOW_STALL_WINDOW_MS, o se cortó una vez y la velocidad medida es baja.
 *  - Se apaga tras SLOW_OFF_AFTER_MS sin cortes y con velocidad sobrada
 *    (sin medición, el triple).
 * La velocidad la reporta hls.js (estimado de descarga de cada segmento).
 * `activations` cuenta los encendidos: App reconecta para aplicar el buffer.
 */
export default function useSlowMode() {
    const [slowMode, setSlowMode] = useState(() => load(K_SLOW, false) === true);
    const [activations, setActivations] = useState(0);

    const slowRef = useRef(slowMode);
    slowRef.current = slowMode;
    const stalls = useRef([]);
    const lastStallAt = useRef(0);
    const changedAt = useRef(Date.now());
    const bw = useRef({ avg: null, samples: 0 });

    const setMode = useCallback((on) => {
        if (slowRef.current === on) return;
        slowRef.current = on;
        changedAt.current = Date.now();
        stalls.current = [];
        bw.current = { avg: null, samples: 0 };
        setSlowMode(on);
        if (on) setActivations((n) => n + 1);
        save(K_SLOW, on);
        console.log(`[BuriTV] Modo internet lento ${on ? 'activado' : 'desactivado'}`);
    }, []);

    const reportStall = useCallback(() => {
        const now = Date.now();
        lastStallAt.current = now;
        if (slowRef.current) return;
        stalls.current = stalls.current.filter((t) => now - t < SLOW_STALL_WINDOW_MS);
        stalls.current.push(now);
        const b = bw.current;
        const slowLink = b.samples >= MIN_BW_SAMPLES && b.avg < SLOW_ON_BPS;
        if (stalls.current.length >= SLOW_ON_STALLS || slowLink) setMode(true);
    }, [setMode]);

    const reportBandwidth = useCallback(
        (bps) => {
            if (!bps || bps <= 0) return;
            const b = bw.current;
            b.avg = b.avg == null ? bps : b.avg + BW_ALPHA * (bps - b.avg);
            b.samples += 1;
            if (b.samples < MIN_BW_SAMPLES) return;
            const now = Date.now();
            if (!slowRef.current) {
                const recentStall = now - lastStallAt.current < SLOW_STALL_WINDOW_MS;
                if (b.avg < SLOW_ON_BPS && recentStall) setMode(true);
            } else if (
                b.avg > SLOW_OFF_BPS &&
                now - Math.max(lastStallAt.current, changedAt.current) > SLOW_OFF_AFTER_MS
            ) {
                setMode(false);
            }
        },
        [setMode],
    );

    useEffect(() => {
        if (!slowMode) return;
        const iv = setInterval(() => {
            const quietFor = Date.now() - Math.max(lastStallAt.current, changedAt.current);
            const b = bw.current;
            const hasData = b.samples >= MIN_BW_SAMPLES;
            if (
                hasData
                    ? quietFor > SLOW_OFF_AFTER_MS && b.avg > SLOW_OFF_BPS
                    : quietFor > OFF_WITHOUT_DATA_MS
            ) {
                setMode(false);
            }
        }, 60000);
        return () => clearInterval(iv);
    }, [slowMode, setMode]);

    return { slowMode, activations, reportStall, reportBandwidth };
}
