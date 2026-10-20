import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame } from '../glyph-frame';
import { GLYPH_CUTOUT } from '../glyph-geometry';

/**
 * Using the computer: a monitor with a face whose eyes follow a cursor zipping around its screen.
 */
export function ComputerGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            <rect height="13.4" rx="2.2" width="19" x="2.5" y="3" />
            <path
                d="M9 20.6h6M12 16.4v4.2"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1.8"
            />
            <g className="computer-eyes">
                <ellipse cx="9.4" cy="9.4" fill={GLYPH_CUTOUT} rx="1.3" ry="1.7" />
                <ellipse cx="14.6" cy="9.4" fill={GLYPH_CUTOUT} rx="1.3" ry="1.7" />
            </g>
            <path
                d="M10.6 12.8q1.4 1 2.8 0"
                fill="none"
                stroke={GLYPH_CUTOUT}
                strokeLinecap="round"
                strokeWidth="1"
            />
            <g className="computer-cursor">
                <path d="M0 0 0 4.6 1.2 3.6 2 5.3 2.8 4.9 2 3.2H3.5Z" fill={GLYPH_CUTOUT} />
            </g>
        </GlyphFrame>
    );
}
