/** "[1][2][3]": la que suena en verde tonal, con un punto que dice si tiene señal. */
export default function OptionSegments({ count, current, status, onSelect, variant = 'panel' }) {
    const signal = status === 'playing' ? 'ok' : status === 'failed' ? 'bad' : 'wait';
    return (
        <div className={`seg-group seg-${variant}`}>
            <div className="seg-track" role="radiogroup" aria-label="Opción de la señal">
                {Array.from({ length: count }, (_, i) => (
                    <button
                        key={i}
                        type="button"
                        role="radio"
                        aria-checked={i === current}
                        aria-label={`Opción ${i + 1}`}
                        className={`seg${i === current ? ' on' : ''}`}
                        onClick={() => onSelect(i)}
                    >
                        {i + 1}
                        {i === current && <span className={`seg-dot ${signal}`} />}
                    </button>
                ))}
            </div>
        </div>
    );
}
