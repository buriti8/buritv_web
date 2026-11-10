import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RESUME_LIVE_MS, WIDE_MIN_PX } from './config';
import useChannels from './hooks/useChannels';
import useFavorites from './hooks/useFavorites';
import useChannelFilter, { ALL } from './hooks/useChannelFilter';
import useStreamRecovery from './hooks/useStreamRecovery';
import useDisplayStatus from './hooks/useDisplayStatus';
import useSlowMode from './hooks/useSlowMode';
import useZapping from './hooks/useZapping';
import useCast from './hooks/useCast';
import useNowPlaying from './hooks/useNowPlaying';
import useEpg from './hooks/useEpg';
import useStreams from './hooks/useStreams';
import Player, { StatusOverlay } from './components/Player';
import MultiView from './components/MultiView';
import Controls from './components/Controls';
import ChannelPlate from './components/ChannelPlate';
import ChannelRow from './components/ChannelRow';
import Filters, { EmptyResults } from './components/Filters';
import OptionSegments from './components/OptionSegments';
import ZapOSD from './components/ZapOSD';
import Toast from './components/Toast';
import Icon from './components/Icon';
import { showToast } from './lib/toast';
import { matchText } from './lib/matchText';
import { epgNowText } from './lib/epgText';
import { streamText } from './lib/streamers';

// Máximo de canales a la vez en la vista múltiple
const MULTI_MAX = 4;

// Controles: se ocultan solos tras este tiempo sin actividad
const HIDE_CONTROLS_MS = { touch: 4500, mouse: 3000 };

function useIsWide() {
    const query = `(min-width: ${WIDE_MIN_PX}px)`;
    const [wide, setWide] = useState(() => window.matchMedia(query).matches);
    useEffect(() => {
        const mq = window.matchMedia(query);
        const on = () => setWide(mq.matches);
        mq.addEventListener('change', on);
        return () => mq.removeEventListener('change', on);
    }, [query]);
    return wide;
}

export default function App() {
    const wide = useIsWide();
    const videoRef = useRef(null);
    const stageRef = useRef(null);

    const [paused, setPaused] = useState(false);
    const [userMuted, setUserMuted] = useState(false);
    // El navegador no dejó arrancar con sonido: silenciado hasta el primer toque
    const [autoMuted, setAutoMuted] = useState(false);
    // Nivel de volumen (0–1), se recuerda entre visitas
    const [volume, setVolumeState] = useState(() => {
        try {
            const v = parseFloat(localStorage.getItem('buritv.volume'));
            return v >= 0 && v <= 1 ? v : 1;
        } catch {
            return 1;
        }
    });
    const [fullscreen, setFullscreen] = useState(false);
    const [controlsVisible, setControlsVisible] = useState(false);
    const hideTimer = useRef(null);
    // Vista múltiple: varios canales a la vez (uno con sonido)
    const [multiTiles, setMultiTiles] = useState(null); // null = apagada
    const [multiFocus, setMultiFocus] = useState(null);
    const multi = multiTiles !== null;
    const uidRef = useRef(0);
    // Panel de canales: completo, compacto u oculto (se recuerda)
    const [panelMode, setPanelMode] = useState(() => {
        try {
            const v = localStorage.getItem('buritv.panel');
            return v === 'compact' || v === 'hidden' ? v : 'full';
        } catch {
            return 'full';
        }
    });
    const changePanelMode = useCallback((mode) => {
        setPanelMode(mode);
        try {
            localStorage.setItem('buritv.panel', mode);
        } catch {}
    }, []);

    const {
        channels,
        current,
        currentIndex,
        source,
        sourceIndex,
        loading,
        loadError,
        retryLoad,
        selectChannel,
        selectSource,
        chooseSource,
        rememberSource,
        rankSources,
        recordSourceResult,
        getEnginePref,
        loadM3U,
    } = useChannels();
    const { favorites, toggleFavorite } = useFavorites();
    const nowPlaying = useNowPlaying();
    const epg = useEpg();
    const streams = useStreams();
    const filter = useChannelFilter(channels, favorites, nowPlaying);
    const { slowMode, activations, reportStall, reportBandwidth } = useSlowMode();

    const cast = useCast({ source, channel: current, castable: source?.type !== 'web' });

    const recovery = useStreamRecovery({
        current,
        source,
        sourceIndex,
        selectSource,
        paused: paused || multi || cast.casting,
        getEnginePref,
        onSourceWorking: rememberSource,
        rankSources,
        onSourceResult: recordSourceResult,
        onStall: reportStall,
        slowMode,
    });
    const { status, retry, resetCycle } = recovery;
    const { displayStatus, quiet } = useDisplayStatus(
        status,
        current ? `${current.id}|${sourceIndex}` : null,
    );
    const muted = userMuted || autoMuted;

    useEffect(() => {
        loadM3U();
    }, [loadM3U]);

    // Internet lento detectado: reconectar con más reserva
    useEffect(() => {
        if (activations > 0) retry();
    }, [activations, retry]);

    // ── Controles: mostrar y ocultar solos ──────────────────────────────
    const showControls = useCallback((kind = 'mouse') => {
        setControlsVisible(true);
        clearTimeout(hideTimer.current);
        hideTimer.current = setTimeout(() => setControlsVisible(false), HIDE_CONTROLS_MS[kind]);
    }, []);
    useEffect(() => () => clearTimeout(hideTimer.current), []);

    // ── Acciones ────────────────────────────────────────────────────────
    const newTile = useCallback(
        (ch, taken = []) => {
            // Si el canal ya está en pantalla, arranca en una opción que no se esté viendo
            const free = ch.sources.findIndex((_, i) => !taken.includes(i));
            const src = taken.length && free >= 0 ? free : (rankSources(ch)[0] ?? 0);
            return { uid: ++uidRef.current, channel: ch, src };
        },
        [rankSources],
    );
    const addTile = useCallback(
        (ch) => {
            if (!multiTiles) return;
            if (multiTiles.length >= MULTI_MAX) {
                showToast(`Máximo ${MULTI_MAX} canales a la vez. Quita uno primero.`);
                return;
            }
            const taken = multiTiles.filter((t) => t.channel.id === ch.id).map((t) => t.src);
            const tile = newTile(ch, taken);
            setMultiTiles([...multiTiles, tile]);
            setMultiFocus(tile.uid);
        },
        [multiTiles, newTile],
    );
    const changeTileChannel = useCallback(
        (uid, ch) => {
            setMultiTiles((tiles) =>
                tiles.map((t) => (t.uid === uid ? { ...newTile(ch, []), uid } : t)),
            );
        },
        [newTile],
    );
    const handleSelectChannel = useCallback(
        (ch) => {
            if (!ch) return;
            if (multi) {
                // En la vista múltiple, elegir un canal de la lista lo agrega;
                // si ya estaba en pantalla, lo quita
                if (multiTiles.some((t) => t.channel.id === ch.id)) {
                    const rest = multiTiles.filter((t) => t.channel.id !== ch.id);
                    if (!rest.length) {
                        showToast('Debe quedar al menos un canal en pantalla.');
                        return;
                    }
                    setMultiTiles(rest);
                    if (!rest.some((t) => t.uid === multiFocus)) setMultiFocus(rest[0].uid);
                } else addTile(ch);
                return;
            }
            selectChannel(ch);
            setPaused(false);
        },
        [selectChannel, multi, multiTiles, multiFocus, addTile],
    );

    const handleSelectSource = useCallback(
        (i) => {
            setPaused(false);
            if (i === sourceIndex) retry();
            else resetCycle();
            chooseSource(i);
        },
        [sourceIndex, retry, resetCycle, chooseSource],
    );

    const zapping = useZapping({
        channels,
        currentIndex,
        sourceIndex,
        onSelectChannel: handleSelectChannel,
        onSelectSource: handleSelectSource,
    });
    const { zapBy, typeDigit, optionBy, showCurrent, osd } = zapping;
    const prevChannel = useCallback(() => zapBy(-1), [zapBy]);
    const nextChannel = useCallback(() => zapBy(1), [zapBy]);

    const enterMulti = useCallback(() => {
        if (!current) return;
        const tile = { uid: ++uidRef.current, channel: current, src: sourceIndex };
        setMultiTiles([tile]);
        setMultiFocus(tile.uid);
        setControlsVisible(false);
    }, [current, sourceIndex]);

    const exitMulti = useCallback(() => {
        // Se vuelve al canal que tenía el sonido
        const keep = multiTiles?.find((t) => t.uid === multiFocus) ?? multiTiles?.[0];
        setMultiTiles(null);
        setMultiFocus(null);
        if (keep && keep.channel.id !== current?.id) selectChannel(keep.channel);
        setPaused(false);
    }, [multiTiles, multiFocus, current, selectChannel]);

    const removeFromMulti = useCallback(
        (id) => {
            const next = multiTiles.filter((t) => t.uid !== id);
            if (!next.length) {
                setMultiTiles(null);
                setMultiFocus(null);
                return;
            }
            setMultiTiles(next);
            if (multiFocus === id) setMultiFocus(next[0].uid);
        },
        [multiTiles, multiFocus],
    );

    const togglePause = useCallback(() => setPaused((p) => !p), []);
    const toggleMute = useCallback(() => {
        if (autoMuted) {
            setAutoMuted(false);
            setUserMuted(false);
            return;
        }
        setUserMuted((m) => !m);
    }, [autoMuted]);

    const setVolume = useCallback((v) => {
        const level = Math.min(1, Math.max(0, Math.round(v * 100) / 100));
        setVolumeState(level);
        try {
            localStorage.setItem('buritv.volume', String(level));
        } catch {}
        // Subir el volumen quita el silencio
        if (level > 0) {
            setUserMuted(false);
            setAutoMuted(false);
        }
    }, []);
    const volumeBy = useCallback((d) => setVolume(volume + d), [setVolume, volume]);

    const toggleFullscreen = useCallback(async () => {
        const el = stageRef.current;
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
            } else if (el?.requestFullscreen) {
                await el.requestFullscreen({ navigationUI: 'hide' });
                // En celular, girar a horizontal
                screen.orientation?.lock?.('landscape').catch(() => {});
            } else if (videoRef.current?.webkitEnterFullscreen) {
                // iPhone: solo el video puede ir a pantalla completa
                videoRef.current.webkitEnterFullscreen();
            }
        } catch {}
    }, []);

    useEffect(() => {
        const on = () => {
            const fs = !!document.fullscreenElement;
            setFullscreen(fs);
            if (!fs) screen.orientation?.unlock?.();
        };
        document.addEventListener('fullscreenchange', on);
        return () => document.removeEventListener('fullscreenchange', on);
    }, []);

    const canPip =
        typeof document !== 'undefined' &&
        document.pictureInPictureEnabled &&
        recovery.engine !== 'web';
    const togglePip = useCallback(async () => {
        try {
            if (document.pictureInPictureElement) await document.exitPictureInPicture();
            else await videoRef.current?.requestPictureInPicture();
        } catch {
            showToast('Imagen en imagen no está disponible para esta señal');
        }
    }, []);

    const toggleCurrentFavorite = useCallback(() => {
        if (!current) return;
        const was = favorites.has(current.id);
        toggleFavorite(current.id);
        showToast(was ? 'Quitado de favoritos' : 'Agregado a favoritos');
    }, [current, favorites, toggleFavorite]);

    const toggleRowFavorite = useCallback(
        (ch) => {
            const was = favorites.has(ch.id);
            toggleFavorite(ch.id);
            showToast(was ? `${ch.name}: quitado de favoritos` : `${ch.name}: agregado a favoritos`);
        },
        [favorites, toggleFavorite],
    );

    // ── El primer gesto del usuario desbloquea el sonido ────────────────
    useEffect(() => {
        if (!autoMuted) return;
        const unlock = () => setAutoMuted(false);
        window.addEventListener('pointerdown', unlock, { once: true });
        window.addEventListener('keydown', unlock, { once: true });
        return () => {
            window.removeEventListener('pointerdown', unlock);
            window.removeEventListener('keydown', unlock);
        };
    }, [autoMuted]);

    // ── Volver a la pestaña: retomar o reconectar al vivo ───────────────
    useEffect(() => {
        let hiddenAt = 0;
        const on = () => {
            if (document.hidden) {
                hiddenAt = Date.now();
                return;
            }
            const v = videoRef.current;
            if (!hiddenAt || !v || paused) return;
            const away = Date.now() - hiddenAt;
            hiddenAt = 0;
            // El navegador la pausó en segundo plano (celular)
            if (v.paused) {
                if (away > RESUME_LIVE_MS) retry();
                else v.play().catch(() => {});
            }
        };
        document.addEventListener('visibilitychange', on);
        return () => document.removeEventListener('visibilitychange', on);
    }, [paused, retry]);

    // ── Teclado (como el control remoto de la TV) ───────────────────────
    useEffect(() => {
        const onKey = (e) => {
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
                if (e.key === 'Escape') t.blur();
                return;
            }
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            const k = e.key;
            if (multi) {
                if (k === 'Escape') {
                    e.preventDefault();
                    exitMulti();
                } else if (k === 'f' || k === 'F') {
                    e.preventDefault();
                    toggleFullscreen();
                } else if (k === 'a' || k === 'A') {
                    e.preventDefault();
                    window.dispatchEvent(new Event('buritv:multi-add'));
                }
                return;
            }
            let handled = true;
            if (k === 'ArrowUp' || k === 'PageUp') zapBy(1);
            else if (k === 'ArrowDown' || k === 'PageDown') zapBy(-1);
            else if (k === 'ArrowLeft') optionBy(-1);
            else if (k === 'ArrowRight') optionBy(1);
            else if (/^[0-9]$/.test(k)) typeDigit(k);
            else if (k === ' ' || k === 'k' || k === 'K') togglePause();
            else if (k === 'm' || k === 'M') toggleMute();
            else if (k === '+' || k === '=') volumeBy(0.1);
            else if (k === '-' || k === '_') volumeBy(-0.1);
            else if (k === 'f' || k === 'F') toggleFullscreen();
            else if (k === 'i' || k === 'I') showCurrent();
            else if (k === 's' || k === 'S') toggleCurrentFavorite();
            else if (k === 'p' || k === 'P') canPip && togglePip();
            else if (k === 'v' || k === 'V') enterMulti();
            else handled = false;
            if (handled) {
                e.preventDefault();
                showControls('mouse');
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [
        zapBy,
        optionBy,
        typeDigit,
        togglePause,
        toggleMute,
        volumeBy,
        toggleFullscreen,
        showCurrent,
        toggleCurrentFavorite,
        togglePip,
        canPip,
        showControls,
        multi,
        exitMulti,
        enterMulti,
    ]);

    // ── Media Session: nombre y logo en la pantalla de bloqueo y el PiP ─
    useEffect(() => {
        const ms = navigator.mediaSession;
        if (!ms || !current) return;
        try {
            ms.metadata = new window.MediaMetadata({
                title: current.name,
                artist: 'BuriTV',
                artwork: current.logo ? [{ src: current.logo, sizes: '512x512' }] : [],
            });
            ms.setActionHandler('play', () => setPaused(false));
            ms.setActionHandler('pause', () => setPaused(true));
            ms.setActionHandler('previoustrack', prevChannel);
            ms.setActionHandler('nexttrack', nextChannel);
        } catch {}
    }, [current, prevChannel, nextChannel]);

    useEffect(() => {
        document.title = current ? `${current.name} · BuriTV` : 'BuriTV';
    }, [current]);

    // ── Lista: dejar a la vista el canal que suena al abrir ─────────────
    const activeRowRef = useRef(null);
    const scrolledOnce = useRef(false);
    useEffect(() => {
        if (scrolledOnce.current || !activeRowRef.current) return;
        scrolledOnce.current = true;
        activeRowRef.current.scrollIntoView({ block: 'center' });
    });

    const showSections = filter.category === ALL && !filter.query.trim();
    // Secciones plegadas (se recuerdan)
    const [collapsed, setCollapsed] = useState(() => {
        try {
            return new Set(JSON.parse(localStorage.getItem('buritv.collapsed') || '[]'));
        } catch {
            return new Set();
        }
    });
    const toggleGroup = useCallback((title) => {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (!next.delete(title)) next.add(title);
            try {
                localStorage.setItem('buritv.collapsed', JSON.stringify([...next]));
            } catch {}
            return next;
        });
    }, []);
    const rows = useMemo(() => {
        const out = [];
        const counts = {};
        if (showSections) filter.items.forEach(({ ch }) => ch.group && (counts[ch.group] = (counts[ch.group] || 0) + 1));
        let lastGroup;
        filter.items.forEach(({ ch, index }) => {
            if (showSections && ch.group && ch.group !== lastGroup) {
                out.push({ type: 'header', title: ch.group, count: counts[ch.group], key: `h-${index}` });
                lastGroup = ch.group;
            }
            if (showSections && ch.group && collapsed.has(ch.group)) return;
            out.push({ type: 'channel', ch, index, key: ch.id });
        });
        return out;
    }, [filter.items, showSections, collapsed]);

    if (loading) return <LoadingScreen error={loadError} onRetry={retryLoad} />;

    const count = current?.sources.length ?? 0;
    const isFav = !!current && favorites.has(current.id);
    const live = displayStatus === 'playing';
    // Escritorio: la placa se ve con los controles o si la señal no está en vivo
    const showPlate = wide && !multi && !osd && (controlsVisible || !live);

    return (
        <div className={`app ${wide ? 'wide' : 'narrow'}${wide && panelMode !== 'full' ? ` panel-${panelMode}` : ''}${fullscreen ? ' is-fs' : ''}`}>
            <main
                ref={stageRef}
                className={`stage${controlsVisible || multi ? ' show-cursor' : ''}`}
                onPointerMove={(e) => !multi && e.pointerType === 'mouse' && showControls('mouse')}
                onClick={(e) => {
                    if (multi || e.target.closest('button, a')) return;
                    if (controlsVisible && !wide) setControlsVisible(false);
                    else showControls(wide ? 'mouse' : 'touch');
                }}
                onDoubleClick={(e) => {
                    if (wide && !multi && !e.target.closest('button, a')) toggleFullscreen();
                }}
            >
                {wide && panelMode === 'hidden' && (
                    <button
                        type="button"
                        className="panel-open"
                        onClick={() => changePanelMode('full')}
                        title="Mostrar la lista de canales"
                    >
                        <Icon name="chevronRight" size={18} />
                        <span className="panel-open-label">Canales</span>
                    </button>
                )}
                <div className={`video-box${multi ? ' is-multi' : ''}`}>
                    {multi && (
                        <MultiView
                            tiles={multiTiles}
                            channels={channels}
                            focusId={multiFocus}
                            max={MULTI_MAX}
                            onAdd={addTile}
                            onChangeChannel={changeTileChannel}
                            onFocus={setMultiFocus}
                            onRemove={removeFromMulti}
                            onExit={exitMulti}
                            onToggleFullscreen={toggleFullscreen}
                            fullscreen={fullscreen}
                            slowMode={slowMode}
                            rankSources={rankSources}
                            getEnginePref={getEnginePref}
                            onSourceResult={recordSourceResult}
                            onStall={reportStall}
                            onAutoplayBlocked={() => setAutoMuted(true)}
                            volume={volume}
                        />
                    )}
                    {!multi && (<>
                    <Player
                        source={source}
                        engine={recovery.engine}
                        relayVideo={recovery.relayVideo}
                        playerKey={recovery.playerKey}
                        probing={recovery.probing}
                        paused={paused || cast.casting}
                        muted={muted}
                        volume={volume}
                        slowMode={slowMode}
                        maxBitRate={recovery.maxBitRate}
                        hasAlternatives={count > 1}
                        videoRef={videoRef}
                        onProgress={recovery.handleProgress}
                        onPlaying={recovery.handlePlaying}
                        onFail={recovery.fail}
                        onBandwidth={reportBandwidth}
                        onAutoplayBlocked={() => setAutoMuted(true)}
                    />
                    <StatusOverlay
                        status={displayStatus}
                        quiet={quiet}
                        paused={paused || cast.casting}
                        channel={current}
                        sourceIndex={sourceIndex}
                        onRetry={() => {
                            setPaused(false);
                            retry();
                        }}
                    />
                    {wide && (
                        <div className={`plate-anchor${showPlate ? ' visible' : ''}`}>
                            {current && (
                                <ChannelPlate
                                    number={currentIndex + 1}
                                    channel={current}
                                    sub={
                                        matchText(nowPlaying[current.id]) ??
                                        streamText(streams.channels[current.id]) ??
                                        epgNowText(epg[current.id]) ??
                                        (count > 1 ? `Opción ${sourceIndex + 1} de ${count}` : null)
                                    }
                                    live={live}
                                />
                            )}
                        </div>
                    )}
                    <ZapOSD osd={osd} channels={channels} nowPlaying={nowPlaying} streams={streams.channels} epg={epg} />
                    <Controls
                        visible={controlsVisible}
                        wide={wide}
                        fullscreen={fullscreen}
                        channel={current}
                        channelNumber={currentIndex + 1}
                        live={live}
                        sourceIndex={sourceIndex}
                        status={displayStatus}
                        paused={paused}
                        muted={muted}
                        volume={volume}
                        setVolume={setVolume}
                        favorite={isFav}
                        canPip={canPip}
                        canCast={cast.available}
                        casting={cast.casting}
                        selectSource={handleSelectSource}
                        prevChannel={prevChannel}
                        nextChannel={nextChannel}
                        togglePause={togglePause}
                        toggleMute={toggleMute}
                        toggleFavorite={toggleCurrentFavorite}
                        togglePip={togglePip}
                        toggleFullscreen={toggleFullscreen}
                        onMulti={enterMulti}
                        onCast={cast.casting ? cast.stop : cast.start}
                    />
                    {cast.casting && (
                        <div className="status status-dark cast-status" role="status">
                            <div className="status-icon">
                                <Icon name="cast" size={28} />
                            </div>
                            <p className="status-title">Transmitiendo a {cast.device}</p>
                            <p className="status-sub">{current?.name}</p>
                            <button type="button" className="btn-tonal" onClick={cast.stop}>
                                <Icon name="close" size={14} /> Dejar de transmitir
                            </button>
                        </div>
                    )}
                    </>)}
                    {autoMuted && (
                        <button type="button" className="unmute-pill" onClick={toggleMute}>
                            <Icon name="mute" size={18} /> Activar sonido
                        </button>
                    )}
                </div>
            </main>

            <aside className="panel">
                {wide && (
                    <header className="brand-bar">
                        <span className="brand">
                            Buri<span className="brand-accent">TV</span>
                        </span>
                        <span className="brand-tools">
                            <button
                                type="button"
                                className={`multi-toggle${multi ? ' on' : ''}`}
                                onClick={multi ? exitMulti : enterMulti}
                                title="Ver varios canales a la vez (V)"
                            >
                                <Icon name="multi" size={16} /> {multi ? 'Salir de varios' : 'Varios canales'}
                            </button>
                            <button
                                type="button"
                                className={`panel-btn${panelMode === 'compact' ? ' on' : ''}`}
                                onClick={() => changePanelMode(panelMode === 'compact' ? 'full' : 'compact')}
                                aria-pressed={panelMode === 'compact'}
                                title={panelMode === 'compact' ? 'Lista completa' : 'Lista compacta'}
                            >
                                <Icon name="list" size={16} />
                            </button>
                            <button
                                type="button"
                                className="panel-btn"
                                onClick={() => changePanelMode('hidden')}
                                title="Ocultar la lista"
                            >
                                <Icon name="chevronLeft" size={18} />
                            </button>
                        </span>
                    </header>
                )}

                {!wide && current && (
                    <section className="now">
                        <div className="now-row">
                            <span className="now-num">{currentIndex + 1}</span>
                            <div className="now-body">
                                <h1 className="now-title">{current.name}</h1>
                                <p className={`now-status${live ? ' live' : ''}`}>
                                    <span
                                        className={`dot${live ? ' live' : displayStatus === 'failed' ? ' bad' : ''}`}
                                    />
                                    {live
                                        ? 'En vivo'
                                        : displayStatus === 'failed'
                                          ? 'Sin señal, seguimos intentando'
                                          : 'Conectando…'}
                                </p>
                            </div>
                            <button
                                type="button"
                                className={`fav-btn${multi ? ' on' : ''}`}
                                onClick={multi ? exitMulti : enterMulti}
                                aria-label="Ver varios canales a la vez"
                            >
                                <Icon name="multi" size={20} />
                            </button>
                            <button
                                type="button"
                                className={`fav-btn${isFav ? ' on' : ''}`}
                                onClick={toggleCurrentFavorite}
                                aria-label={isFav ? 'Quitar de favoritos' : 'Agregar a favoritos'}
                                aria-pressed={isFav}
                            >
                                <Icon name={isFav ? 'star' : 'starOutline'} size={20} />
                            </button>
                        </div>
                        {count > 1 && (
                            <OptionSegments
                                count={count}
                                current={sourceIndex}
                                status={displayStatus}
                                onSelect={handleSelectSource}
                            />
                        )}
                    </section>
                )}

                <Filters filter={filter} totalCount={channels.length} />

                <div className="list" role="list">
                    {rows.length ? (
                        rows.map((row) =>
                            row.type === 'header' ? (
                                <h2 key={row.key} className="section-title">
                                    <button
                                        type="button"
                                        className={`section-toggle${collapsed.has(row.title) ? ' closed' : ''}`}
                                        aria-expanded={!collapsed.has(row.title)}
                                        onClick={() => toggleGroup(row.title)}
                                    >
                                        <Icon name="chevronDown" size={16} />
                                        <span className="section-name">{row.title}</span>
                                        <span className="section-count">{row.count}</span>
                                    </button>
                                </h2>
                            ) : (
                                <ChannelRow
                                    key={row.key}
                                    ref={row.ch.id === current?.id ? activeRowRef : undefined}
                                    item={row.ch}
                                    index={row.index}
                                    active={multi ? multiTiles.some((t) => t.channel.id === row.ch.id) : row.ch.id === current?.id}
                                    favorite={favorites.has(row.ch.id)}
                                    match={nowPlaying[row.ch.id]}
                                    stream={streams.channels[row.ch.id]}
                                    epg={epg[row.ch.id]}
                                    onSelect={handleSelectChannel}
                                    onToggleFavorite={toggleRowFavorite}
                                />
                            ),
                        )
                    ) : (
                        <EmptyResults query={filter.query.trim()} onClear={filter.clear} />
                    )}
                </div>
                {wide && multi && (
                    <p className="hint" aria-label="Atajos de teclado">
                        <span><kbd>A</kbd>agregar canal</span>
                        <span><kbd>F</kbd>pantalla completa</span>
                        <span><kbd>Esc</kbd>salir de varios</span>
                    </p>
                )}
                {wide && !multi && (
                    <p className="hint" aria-label="Atajos de teclado">
                        <span><kbd>↑</kbd><kbd>↓</kbd>canal</span>
                        <span><kbd>←</kbd><kbd>→</kbd>opción</span>
                        <span><kbd>0-9</kbd>ir al canal</span>
                        <span><kbd>Espacio</kbd>pausa</span>
                        <span><kbd>M</kbd>sonido</span>
                        <span><kbd>F</kbd>pantalla completa</span>
                        <span><kbd>V</kbd>varios canales</span>
                    </p>
                )}
            </aside>
            <Toast />
        </div>
    );
}

function LoadingScreen({ error, onRetry }) {
    return (
        <div className="loader">
            <span className="brand brand-xl">
                Buri<span className="brand-accent">TV</span>
            </span>
            {error ? (
                <div className="load-error">
                    <p className="load-error-title">{error.message}</p>
                    <p className="load-error-sub">
                        Reintentamos solos en {Math.round(error.retryIn / 1000)} s
                    </p>
                    <button type="button" className="btn-tonal" onClick={onRetry}>
                        Reintentar ahora
                    </button>
                </div>
            ) : (
                <>
                    <span className="spinner" />
                    <p className="loader-text">Cargando canales…</p>
                </>
            )}
        </div>
    );
}
