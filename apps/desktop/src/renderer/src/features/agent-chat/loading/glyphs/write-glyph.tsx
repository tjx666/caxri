import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame } from '../glyph-frame';
import { GLYPH_CUTOUT, sparklePath, staggerIndex } from '../glyph-geometry';

const KEYCAPS = [6.4, 9.6, 12.8, 16] as const;

/**
 * Writing a new file: a typewriter. Keys hammer in turn while the carriage steps left, then it dings and returns.
 */
export function WriteGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            <g className="write-carriage">
                <rect
                    fill="none"
                    height="8.2"
                    rx=".6"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    width="10"
                    x="7"
                    y="2.6"
                />
                <path
                    className="write-typed"
                    d="M8.8 5.4h6.4M8.8 7.8h6.4"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeWidth="1.1"
                />
                <rect height="2.2" rx="1.1" width="15" x="4.5" y="9.6" />
            </g>
            <path d="M4 13.4h16a1.6 1.6 0 0 1 1.6 1.8l-.6 4a1.6 1.6 0 0 1-1.6 1.4H4.6A1.6 1.6 0 0 1 3 19.2l-.6-4A1.6 1.6 0 0 1 4 13.4z" />
            {KEYCAPS.map((x, index) => (
                <rect
                    className="write-keycap"
                    fill={GLYPH_CUTOUT}
                    height="1.6"
                    key={x}
                    rx=".5"
                    style={staggerIndex(index)}
                    width="2"
                    x={x}
                    y="15.6"
                />
            ))}
            <path
                className="write-ding"
                d={sparklePath(21.6, 6.6, 2.4, 0.2)}
                fill="var(--warning)"
            />
        </GlyphFrame>
    );
}
