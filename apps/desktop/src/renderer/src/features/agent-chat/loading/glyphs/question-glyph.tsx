import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame } from '../glyph-frame';
import { pivotAt, pivotOnSelf } from '../glyph-geometry';

/**
 * Asking the user: a question mark tilts its head like a curious puppy while its dot bounces.
 */
export function QuestionGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            <g className="question-tilt" style={pivotAt(12, 15)}>
                <path
                    d="M8 8.4a4 4 0 1 1 5.6 3.7c-1 .5-1.6 1.2-1.6 2.3v.6"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeWidth="2.6"
                />
            </g>
            <g className="question-dot-hop">
                <ellipse
                    className="question-dot-squash"
                    cx="12"
                    cy="19.6"
                    rx="1.6"
                    ry="1.6"
                    style={pivotOnSelf('center bottom')}
                />
            </g>
        </GlyphFrame>
    );
}
