import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame, GooGroup } from '../glyph-frame';
import { GLYPH_CUTOUT, pivotAt, pivotOnSelf } from '../glyph-geometry';

/**
 * Starting a subagent: mitosis. The parent blob buds a baby that pops off, hops, and opens its eyes.
 */
export function AgentGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            <GooGroup>
                <circle
                    className="agent-parent"
                    cx="8.5"
                    cy="12.5"
                    r="4.6"
                    style={pivotOnSelf('center bottom')}
                />
                <circle className="agent-child" cx="8.5" cy="13.6" r="2.9" />
            </GooGroup>
            <g className="glyph-blink" style={pivotAt(8.5, 11.6)}>
                <ellipse cx="7.1" cy="11.6" fill={GLYPH_CUTOUT} rx=".75" ry="1.05" />
                <ellipse cx="9.9" cy="11.6" fill={GLYPH_CUTOUT} rx=".75" ry="1.05" />
            </g>
            <g className="agent-child-eyes">
                <circle cx="7.85" cy="13.3" fill={GLYPH_CUTOUT} r=".55" />
                <circle cx="9.35" cy="13.3" fill={GLYPH_CUTOUT} r=".55" />
            </g>
        </GlyphFrame>
    );
}
