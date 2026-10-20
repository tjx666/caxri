import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame, GooGroup } from '../glyph-frame';
import { GLYPH_CUTOUT } from '../glyph-geometry';

/**
 * Reading: a bookworm humps across the top of an open book in four strides, then takes a bite out of the page edge.
 */
export function ReadGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            <path d="M11.4 11.4C9.4 9.9 6.6 9.7 3.6 10.5V19.4C6.6 18.6 9.4 18.8 11.4 20.2Z" />
            <path d="M12.6 11.4C14.6 9.9 17.4 9.7 20.4 10.5V19.4C17.4 18.6 14.6 18.8 12.6 20.2Z" />
            <circle className="read-bite" cx="20.4" cy="12.6" fill={GLYPH_CUTOUT} r="1.5" />
            <g className="read-worm">
                <GooGroup blur={0.8}>
                    <circle className="read-worm-tail" cx="5.4" cy="7.4" r="1.45" />
                    <circle className="read-worm-middle" cx="7.6" cy="7.4" r="1.45" />
                    <circle className="read-worm-head" cx="9.8" cy="7.4" r="1.8" />
                </GooGroup>
                <g className="read-worm-head">
                    <circle cx="10.4" cy="6.9" fill={GLYPH_CUTOUT} r=".5" />
                </g>
            </g>
        </GlyphFrame>
    );
}
