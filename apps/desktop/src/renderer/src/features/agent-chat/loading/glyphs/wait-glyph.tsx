import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame } from '../glyph-frame';
import { GLYPH_CUTOUT, pivotAt, pivotOnSelf } from '../glyph-geometry';

/**
 * Waiting: a snail inches across with its eye stalks swaying, leaving a fading slime trail.
 */
export function WaitGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            <rect
                className="wait-slime"
                height="1.2"
                rx=".6"
                style={pivotOnSelf('left center')}
                width="14"
                x="2"
                y="18.6"
            />
            <g className="wait-snail">
                <g className="wait-body" style={pivotOnSelf('left bottom')}>
                    <path d="M5.4 18.8h10.8c1.4 0 2.6-1 2.6-2.4v-3h-2.4l-.6 2.6H5.4a1.4 1.4 0 0 0 0 2.8z" />
                    <g className="wait-stalk" style={pivotAt(17.2, 13.6)}>
                        <path
                            d="M17 13.6 16.2 9.4"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeWidth="1"
                        />
                        <circle cx="16.1" cy="9.1" r="1.05" />
                    </g>
                    <g className="wait-stalk wait-stalk-late" style={pivotAt(18.4, 13.6)}>
                        <path
                            d="M18.4 13.6 19.4 9.6"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeWidth="1"
                        />
                        <circle cx="19.5" cy="9.3" r="1.05" />
                    </g>
                </g>
                <g className="wait-shell" style={pivotOnSelf('center bottom')}>
                    <circle cx="10" cy="12.4" r="5" />
                    <path
                        d="M10 12.4a1.4 1.4 0 0 1 1.4 1.4 2.4 2.4 0 0 1-4.8 0 3.6 3.6 0 0 1 7.2-.4"
                        fill="none"
                        stroke={GLYPH_CUTOUT}
                        strokeLinecap="round"
                        strokeWidth="1.1"
                    />
                </g>
            </g>
        </GlyphFrame>
    );
}
