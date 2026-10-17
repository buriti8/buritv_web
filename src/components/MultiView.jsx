import { useRef, useState, useEffect, useMemo } from 'react';
import useStreamRecovery from '../hooks/useStreamRecovery';
import Player, { StatusOverlay } from './Player';
import Icon from './Icon';

/** Cierra un menú al hacer clic fuera o al pulsar Escape. */
function useDismiss(open, onClose) {
    const ref = useRef(null);
    useEffect(() => {
        if (!open) return;
        const down = (e) => {
            if (ref.current && !ref.current.contains(e.target)) onClose();
        };
        const key = (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
            }
        };
        document.addEventListener('pointerdown', down, true);
        document.addEventListener('keydown', key, true);
        return () => {
            document.removeEventListener('pointerdown', down, true);
            document.removeEventListener('keydown', key, true);
        };
    }, [open, onClose]);
    return ref;
}

/** Menú desplegable para escoger la opción (fuente) de un canal. */
function OptionMenu({ count, current, onPick }) {
    const [open, setOpen] = useState(false);
    const close = () => setOpen(false);
    const ref = useDismiss(open, close);
    return (
        <div className="tile-menu" ref={ref} onClick={(e) => e.stopPropagation()}>
            <button
                type="button"
                className={`tile-btn tile-opt${open ? ' on' : ''}`}
                aria-haspopup="listbox"
                aria-expanded={open}
                title="Elegir opción"
                onClick={() => setOpen(!open)}
            >
                Opción {current + 1}
                <Icon name="chevronDown" size={14} />
            </button>
            {open && (
                <ul className="menu" role="listbox" aria-label="Opciones del canal">
                    {Array.from({ length: count }, (_, i) => (
                        <li key={i} role="option" aria-selected={i === current}>
                            <button
                                type="button"
                                className={`menu-item${i === current ? ' on' : ''}`}
                                onClick={() => {
                                    close();
                                    onPick(i);
                                }}
                            >
                                <span>Opción {i + 1}</span>
                                {i === current && <Icon name="check" size={14} />}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/** Lista con buscador para escoger un canal (cubre el recuadro o el área). */
function ChannelPicker({ channels, activeIds, title, onPick, onClose }) {
    const [q, setQ] = useState('');
    const ref = useDismiss(true, onClose);
    const found = useMemo(() => {
        const t = q.trim().toLowerCase();
        const list = channels.map((c, i) => ({ c, n: i + 1 }));
        return t
            ? list.filter(({ c, n }) => c.name.toLowerCase().includes(t) || String(n) === t)
            : list;
    }, [channels, q]);
    return (
        <div className="picker" ref={ref} onClick={(e) => e.stopPropagation()}>
            <div className="picker-head">
                <strong>{title}</strong>
                <button type="button" className="tile-btn" aria-label="Cerrar" onClick={onClose}>
                    <Icon name="close" size={14} />
                </button>
            </div>
            <input
                className="picker-search"
                type="search"
                autoFocus
                placeholder="Buscar canal o número"
                value={q}
                onChange={(e) => setQ(e.target.value)}
            />
            <ul className="picker-list">
                {found.map(({ c, n }) => (
                    <li key={c.id}>
                        <button
                            type="button"
                            className={`picker-item${activeIds.has(c.id) ? ' on' : ''}`}
                            onClick={() => onPick(c)}
                        >
                            <span className="picker-num">{n}</span>
                            <span className="picker-name">{c.name}</span>
                            {c.sources.length > 1 && (
                                <span className="picker-opts">{c.sources.length} opciones</span>
                            )}
                        </button>
                    </li>
                ))}
                {!found.length && (
                    <li className="picker-none">Ningún canal coincide con la búsqueda</li>
                )}
            </ul>
        </div>
    );
}

/**
 * Un canal dentro de la vista múltiple: su propio reproductor y su propia
 * recuperación. Solo el canal con el sonido activo suena; el resto va mudo.
 */
function Tile({
    channel,
    initialSource,
    channels,
    number,
    focused,
    volume,
    slowMode,
    rankSources,
    getEnginePref,
    onSourceResult,
    onStall,
    onFocus,
    onRemove,
    onChangeChannel,
    onAutoplayBlocked,
}) {
    const videoRef = useRef(null);
    const [sourceIndex, setSourceIndex] = useState(
        () => initialSource ?? rankSources(channel)[0] ?? 0,
    );
    const [picking, setPicking] = useState(false);
    const source = channel.sources[sourceIndex] || channel.sources[0] || null;
    const count = channel.sources.length;

    const recovery = useStreamRecovery({
        current: channel,
        source,
        sourceIndex,
        selectSource: setSourceIndex,
        paused: false,
        getEnginePref,
        rankSources,
        onSourceResult,
        onStall,
        slowMode,
    });
    const { status } = recovery;

    return (
        <div className={`tile${focused ? ' focused' : ''}`} onClick={onFocus}>
            <Player
                source={source}
                engine={recovery.engine}
                relayVideo={recovery.relayVideo}
                playerKey={recovery.playerKey}
                probing={recovery.probing}
                paused={false}
                muted={!focused}
                volume={volume}
                slowMode={slowMode}
                maxBitRate={recovery.maxBitRate}
                hasAlternatives={count > 1}
                videoRef={videoRef}
                onProgress={recovery.handleProgress}
                onPlaying={recovery.handlePlaying}
                onFail={recovery.fail}
                onAutoplayBlocked={focused ? onAutoplayBlocked : undefined}
            />
            <StatusOverlay
                status={status}
                quiet={false}
                paused={false}
                channel={channel}
                sourceIndex={sourceIndex}
                onRetry={recovery.retry}
            />
            <div className="tile-bar">
                <span className="tile-num">{number}</span>
                <span className="tile-name">{channel.name}</span>
                {count > 1 && (
                    <OptionMenu
                        count={count}
                        current={sourceIndex}
                        onPick={(i) => {
                            recovery.resetCycle();
                            setSourceIndex(i);
                        }}
                    />
                )}
                <button
                    type="button"
                    className="tile-btn"
                    aria-label="Cambiar de canal"
                    title="Cambiar de canal"
                    onClick={(e) => {
                        e.stopPropagation();
                        setPicking(true);
                    }}
                >
                    <Icon name="list" size={16} />
                </button>
                <button
                    type="button"
                    className={`tile-btn${focused ? ' on' : ''}`}
                    aria-label={focused ? 'Con sonido' : 'Escuchar este canal'}
                    title={focused ? 'Con sonido' : 'Escuchar este canal'}
                    onClick={(e) => {
                        e.stopPropagation();
                        onFocus();
                    }}
                >
                    <Icon name={focused ? 'volume' : 'mute'} size={18} />
                </button>
                <button
                    type="button"
                    className="tile-btn"
                    aria-label="Quitar de la vista"
                    title="Quitar de la vista"
                    onClick={(e) => {
                        e.stopPropagation();
                        onRemove();
                    }}
                >
                    <Icon name="close" size={16} />
                </button>
            </div>
            {picking && (
                <ChannelPicker
                    channels={channels}
                    activeIds={new Set([channel.id])}
                    title="Cambiar este recuadro a"
                    onClose={() => setPicking(false)}
                    onPick={(ch) => {
                        setPicking(false);
                        if (ch.id !== channel.id) onChangeChannel(ch);
                    }}
                />
            )}
        </div>
    );
}

/** Canales reproduciéndose a la vez, centrados y siempre en 16:9. */
export default function MultiView({
    tiles,
    channels,
    focusId,
    max,
    onAdd,
    onChangeChannel,
    onFocus,
    onRemove,
    onExit,
    onToggleFullscreen,
    fullscreen,
    ...shared
}) {
    const n = tiles.length;
    // Con 1 o 3 canales se deja a la vista el recuadro que falta para completar la cuadrícula
    const slot = n === 1 || n === 3;
    const slots = n + (slot && n < max ? 1 : 0);
    const cols = slots <= 1 ? 1 : 2;
    const rows = Math.ceil(slots / cols);
    const [adding, setAdding] = useState(false);
    const numberOf = (ch) => channels.findIndex((c) => c.id === ch.id) + 1;
    // Tecla A (desde App): abrir el selector para agregar un canal
    useEffect(() => {
        const open = () => n < max && setAdding(true);
        window.addEventListener('buritv:multi-add', open);
        return () => window.removeEventListener('buritv:multi-add', open);
    }, [n, max]);
    const activeIds = useMemo(() => new Set(tiles.map((t) => t.channel.id)), [tiles]);

    return (
        <div className="multi">
            <div className="multi-grid">
                <div className="multi-grid-inner" style={{ '--cols': cols, '--rows': rows }}>
                    {tiles.map((t) => (
                        <Tile
                            key={`${t.uid}-${t.channel.id}`}
                            channel={t.channel}
                            initialSource={t.src}
                            channels={channels}
                            number={numberOf(t.channel)}
                            focused={t.uid === focusId}
                            onFocus={() => onFocus(t.uid)}
                            onRemove={() => onRemove(t.uid)}
                            onChangeChannel={(ch) => onChangeChannel(t.uid, ch)}
                            {...shared}
                        />
                    ))}
                    {slots > n && (
                        <button
                            type="button"
                            className="tile tile-empty"
                            onClick={() => setAdding(true)}
                        >
                            <Icon name="plus" size={28} />
                            <strong>Agregar otro canal</strong>
                            <span>Toca aquí o elige uno de la lista</span>
                        </button>
                    )}
                </div>
            </div>
            <div className="multi-actions">
                <span className="multi-count">
                    {n} de {max}
                </span>
                {n < max && (
                    <button type="button" className="multi-btn" onClick={() => setAdding(true)}>
                        <Icon name="plus" size={16} /> Agregar canal <kbd className="multi-key">A</kbd>
                    </button>
                )}
                <button type="button" className="multi-btn" onClick={onToggleFullscreen}>
                    <Icon name={fullscreen ? 'compress' : 'expand'} size={18} />
                    {fullscreen ? 'Salir' : 'Pantalla completa'}
                </button>
                <button type="button" className="multi-btn" onClick={onExit}>
                    <Icon name="close" size={16} /> Salir de varios canales
                </button>
            </div>
            {adding && (
                <div className="picker-scrim">
                    <ChannelPicker
                        channels={channels}
                        activeIds={activeIds}
                        title="Agregar a la vista"
                        onClose={() => setAdding(false)}
                        onPick={(ch) => {
                            setAdding(false);
                            onAdd(ch);
                        }}
                    />
                </div>
            )}
        </div>
    );
}
