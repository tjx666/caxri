import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame } from '../glyph-frame';
import { staggerIndex } from '../glyph-geometry';

const ROWS = [6, 12, 18] as const;

/**
 * Updating the plan: checks pop in down the list one after another, lighting up each item.
 */
export function PlanGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            {ROWS.map((y, index) => (
                <g key={y}>
                    <path
                        className="plan-check"
                        d={`M3.2 ${y}l1.6 1.6 3-3.4`}
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2.2"
                        style={staggerIndex(index)}
                    />
                    <rect
                        className="plan-item"
                        height="2.6"
                        rx="1.3"
                        style={staggerIndex(index)}
                        width="10"
                        x="10.5"
                        y={y - 1.3}
                    />
                </g>
            ))}
        </GlyphFrame>
    );
}
