import ChannelPlate from './ChannelPlate';

/** Banner de cambio de canal (teclado): la placa en grande, entra desde la izquierda. */
export default function ZapOSD({ osd, channels }) {
    if (!osd) return null;
    const ch = osd.index >= 0 ? channels[osd.index] : null;
    const number =
        osd.kind === 'digits' ? osd.digits.padEnd(osd.maxLen, '_') : String(osd.index + 1);
    let sub = null;
    if (osd.kind === 'digits' && osd.invalid) sub = 'Ese canal no existe';
    else if (osd.kind === 'option') sub = `Opción ${osd.option + 1} de ${osd.count}`;
    else if (ch && ch.sources.length > 1) sub = `${ch.sources.length} opciones`;
    return (
        <div className="osd">
            <ChannelPlate
                size="osd"
                number={number}
                channel={osd.invalid ? null : ch}
                sub={sub}
                warn={!!osd.invalid}
            />
        </div>
    );
}
