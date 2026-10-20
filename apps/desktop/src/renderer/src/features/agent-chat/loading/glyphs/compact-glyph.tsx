import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame, GooGroup } from '../glyph-frame';
import { GLYPH_CUTOUT } from '../glyph-geometry';

/**
 * Compacting the context: three blobs squeeze into one, its eyes pinch to `> <`, and it springs back.
 */
export function CompactGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            <GooGroup>
                <circle className="compact-top" cx="12" cy="5" r="2.5" />
                <circle className="compact-middle" cx="12" cy="12" r="3.6" />
                <circle className="compact-bottom" cx="12" cy="19" r="2.5" />
            </GooGroup>
            <g className="compact-eyes-open">
                <circle cx="10.6" cy="11.6" fill={GLYPH_CUTOUT} r=".65" />
                <circle cx="13.4" cy="11.6" fill={GLYPH_CUTOUT} r=".65" />
            </g>
            <g
                className="compact-eyes-squint"
                fill="none"
                stroke={GLYPH_CUTOUT}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth=".9"
            >
                <path d="m9.6 11 1.3.8-1.3.8" />
                <path d="m14.4 11-1.3.8 1.3.8" />
            </g>
        </GlyphFrame>
    );
}
