import ChannelPlate from './ChannelPlate';
import OptionSegments from './OptionSegments';
import Icon from './Icon';

function Btn({ icon, label, onClick, size = 'md', className = '' }) {
    return (
        <button
            type="button"
            className={`ctrl ctrl-${size} ${className}`}
            onClick={(e) => {
                e.stopPropagation();
                onClick();
            }}
            aria-label={label}
            title={label}
        >
            <Icon name={icon} size={size === 'lg' ? 24 : size === 'md' ? 18 : 16} />
        </button>
    );
}

/**
 * Controles sobre el video (igual que la app):
 *   arriba   placa del canal (y volver, en pantalla completa)
 *   abajo    canal anterior · reproducir/pausar · canal siguiente (centro),
 *            y solo esa franja se oscurece
 *   abajo    opciones a la izquierda; sonido, favorito, PiP y pantalla completa
 * En celular sin pantalla completa las opciones van bajo el video, no aquí.
 */
export default function Controls({
    visible,
    wide,
    fullscreen,
    channel,
    channelNumber,
    live,
    sourceIndex,
    status,
    paused,
    muted,
    volume,
    favorite,
    canPip,
    canCast,
    casting,
    selectSource,
    prevChannel,
    nextChannel,
    togglePause,
    toggleMute,
    setVolume,
    toggleFavorite,
    togglePip,
    toggleFullscreen,
    onMulti,
    onCast,
}) {
    const count = channel?.sources.length ?? 0;
    const showOptions = count > 1 && (wide || fullscreen);
    return (
        <div className={`controls${visible ? ' visible' : ''}`} aria-hidden={!visible}>
            <div className="controls-top">
                {fullscreen && !wide && (
                    <Btn icon="back" label="Salir de pantalla completa" onClick={toggleFullscreen} size="sm" />
                )}
                {channel && !wide && (
                    <ChannelPlate size="sm" number={channelNumber} channel={channel} live={live} />
                )}
            </div>

            <div className="controls-bottom">
            <div className="controls-center">
                <Btn icon="prev" label="Canal anterior" onClick={prevChannel} />
                <Btn
                    icon={paused ? 'play' : 'pause'}
                    label={paused ? 'Reproducir' : 'Pausar'}
                    onClick={togglePause}
                    size="lg"
                />
                <Btn icon="next" label="Canal siguiente" onClick={nextChannel} />
            </div>
                <div className="controls-left">
                {showOptions ? (
                    <OptionSegments
                        count={count}
                        current={sourceIndex}
                        status={status}
                        onSelect={selectSource}
                        variant={wide ? 'tv' : 'video'}
                    />
                ) : null}
                </div>
                <div className="controls-util">
                    <div className={`volume${muted ? ' is-muted' : ''}`}>
                        <Btn
                            icon={muted || volume === 0 ? 'mute' : 'volume'}
                            label={muted ? 'Activar sonido (M)' : 'Silenciar (M)'}
                            onClick={toggleMute}
                            size="sm"
                        />
                        {/* Popover vertical del volumen: se despliega hacia arriba al pasar el cursor */}
                        <div className="volume-pop">
                        <input
                            type="range"
                            className="volume-slider"
                            min="0"
                            max="100"
                            step="1"
                            value={muted ? 0 : Math.round(volume * 100)}
                            onChange={(e) => setVolume(Number(e.target.value) / 100)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                            aria-label="Volumen"
                            title="Volumen (+ / -)"
                            style={{ '--vol': `${muted ? 0 : Math.round(volume * 100)}%` }}
                        />
                        </div>
                    </div>
                    {wide && (
                        <Btn
                            icon={favorite ? 'star' : 'starOutline'}
                            label={favorite ? 'Quitar de favoritos' : 'Agregar a favoritos'}
                            onClick={toggleFavorite}
                            size="sm"
                            className={favorite ? 'is-fav' : ''}
                        />
                    )}
                    {onMulti && (
                        <Btn icon="multi" label="Varios canales a la vez" onClick={onMulti} size="sm" />
                    )}
                    {canCast && (
                        <Btn
                            icon="cast"
                            label={casting ? 'Transmitiendo a Chromecast' : 'Enviar a Chromecast'}
                            onClick={onCast}
                            size="sm"
                            className={casting ? 'is-fav' : ''}
                        />
                    )}
                    {canPip && (
                        <Btn icon="pip" label="Imagen en imagen" onClick={togglePip} size="sm" />
                    )}
                    <Btn
                        icon={fullscreen ? 'compress' : 'expand'}
                        label={fullscreen ? 'Salir de pantalla completa (F)' : 'Pantalla completa (F)'}
                        onClick={toggleFullscreen}
                        size="sm"
                    />
                </div>
            </div>
        </div>
    );
}
