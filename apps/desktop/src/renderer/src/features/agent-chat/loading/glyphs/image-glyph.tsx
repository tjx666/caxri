import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame } from '../glyph-frame';
import { GLYPH_CUTOUT, pivotAt } from '../glyph-geometry';

/**
 * Viewing an image: a Polaroid gets a shake, and the picture slowly develops.
 */
export function ImageGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            <g className="image-shake" style={pivotAt(12, 12)}>
                <rect height="17" rx="1.6" width="14" x="5" y="3.5" />
                <rect fill={GLYPH_CUTOUT} height="9.5" rx=".6" width="10" x="7" y="5.5" />
                <g className="image-develop">
                    <circle cx="14.4" cy="8.3" r="1.3" />
                    <path d="M7 15l3.2-3.6 2.4 2.4 1.6-1.6 2.8 2.8z" />
                </g>
            </g>
        </GlyphFrame>
    );
}
