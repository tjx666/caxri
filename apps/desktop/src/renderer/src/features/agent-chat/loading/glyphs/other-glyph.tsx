import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame } from '../glyph-frame';
import { GLYPH_CUTOUT, pivotAt, pivotOnSelf } from '../glyph-geometry';

/**
 * Any other tool: a wind-up toy. The key on its head turns a few times, then it waddles on tiny feet.
 */
export function OtherGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            <g className="other-waddle" style={pivotOnSelf('center bottom')}>
                <g className="other-key" style={pivotAt(12, 4)}>
                    <path
                        d="M12 8.6V4"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeWidth="1.5"
                    />
                    <path
                        d="M12 4C10.6 2 7.6 1.6 7.6 3.6S10.6 5.6 12 4c1.4-2 4.4-2.4 4.4-.4S13.4 5.6 12 4z"
                        fill="none"
                        stroke="currentColor"
                        strokeLinejoin="round"
                        strokeWidth="1.5"
                    />
                </g>
                <rect height="10.6" rx="5.3" width="14" x="5" y="8" />
                <g className="glyph-blink" style={pivotAt(12, 12.4)}>
                    <ellipse cx="10" cy="12.4" fill={GLYPH_CUTOUT} rx=".85" ry="1.15" />
                    <ellipse cx="14" cy="12.4" fill={GLYPH_CUTOUT} rx=".85" ry="1.15" />
                </g>
                <path
                    d="M11 15q1 .8 2 0"
                    fill="none"
                    stroke={GLYPH_CUTOUT}
                    strokeLinecap="round"
                    strokeWidth=".9"
                />
                <rect className="other-foot" height="2.6" rx="1" width="3" x="7.6" y="17.6" />
                <rect
                    className="other-foot other-foot-late"
                    height="2.6"
                    rx="1"
                    width="3"
                    x="13.4"
                    y="17.6"
                />
            </g>
        </GlyphFrame>
    );
}
