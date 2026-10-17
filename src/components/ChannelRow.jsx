import { forwardRef, memo, useRef, useState } from 'react';
import Icon from './Icon';

/**
 * Fila de canal: número, logo, nombre y estado.
 * Favorito: mantener presionado (táctil) o clic derecho.
 */
const ChannelRow = memo(
    forwardRef(function ChannelRow({ item, index, active, favorite, onSelect, onToggleFavorite }, ref) {
        const [logoError, setLogoError] = useState(false);
        const press = useRef({ timer: null, long: false });
        const count = item.sources.length;

        const startPress = () => {
            press.current.long = false;
            press.current.timer = setTimeout(() => {
                press.current.long = true;
                onToggleFavorite(item);
            }, 600);
        };
        const endPress = () => clearTimeout(press.current.timer);

        return (
            <button
                ref={ref}
                type="button"
                className={`row${active ? ' active' : ''}`}
                aria-current={active ? 'true' : undefined}
                onClick={() => {
                    if (!press.current.long) onSelect(item);
                    press.current.long = false;
                }}
                onContextMenu={(e) => {
                    e.preventDefault();
                    onToggleFavorite(item);
                }}
                onPointerDown={(e) => e.pointerType === 'touch' && startPress()}
                onPointerUp={endPress}
                onPointerLeave={endPress}
                onPointerCancel={endPress}
            >
                <span className="row-num">{index + 1}</span>
                <span className="logo-tile">
                    {item.logo && !logoError ? (
                        <img src={item.logo} alt="" loading="lazy" onError={() => setLogoError(true)} />
                    ) : (
                        <span className="logo-fallback">{item.name.slice(0, 2)}</span>
                    )}
                </span>
                <span className="row-body">
                    <span className="row-name">{item.name}</span>
                    {(active || count > 1) && (
                        <span className="row-sub">{active ? 'Reproduciendo' : `${count} opciones`}</span>
                    )}
                </span>
                {favorite && (
                    <span className="row-fav" title="Favorito">
                        <Icon name="star" size={16} />
                    </span>
                )}
                {active && (
                    <span className="row-playing">
                        <Icon name="volume" size={18} />
                    </span>
                )}
            </button>
        );
    }),
);

export default ChannelRow;
