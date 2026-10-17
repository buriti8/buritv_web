import { useState } from 'react';

/**
 * Placa del canal al estilo del marcador de una transmisión deportiva:
 * número · logo · nombre (+ subtítulo) · "En vivo", en una sola pieza.
 *  size: 'tv' | 'osd' (cambio de canal, grande) | 'sm' (sobre el video en celular)
 */
export default function ChannelPlate({ number, channel, sub, live, warn, size = 'tv' }) {
    const [logoError, setLogoError] = useState(false);
    return (
        <div className={`plate-row plate-${size}`} aria-hidden="true">
            <div className="plate">
                {number != null && <div className={`plate-num${warn ? ' warn' : ''}`}>{number}</div>}
                {channel?.logo && !logoError && (
                    <div className="plate-logo">
                        <img src={channel.logo} alt="" onError={() => setLogoError(true)} />
                    </div>
                )}
                {(channel || sub) && (
                    <div className="plate-body">
                        {channel && <span className="plate-name">{channel.name}</span>}
                        {sub && <span className={`plate-sub${warn ? ' warn' : ''}`}>{sub}</span>}
                    </div>
                )}
            </div>
            {live && (
                <div className="plate-live">
                    <span className="dot" />
                    En vivo
                </div>
            )}
        </div>
    );
}
