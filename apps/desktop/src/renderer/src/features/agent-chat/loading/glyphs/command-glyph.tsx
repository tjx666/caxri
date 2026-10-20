import type { CSSProperties } from 'react';

import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame } from '../glyph-frame';
import { GLYPH_CUTOUT, pivotAt, pivotOnSelf } from '../glyph-geometry';

/**
 * Running a command: the terminal's block cursor is a little buddy hopping after the prompt, squashing as it lands and
 * kicking up dust.
 */
export function CommandGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            <path
                className="command-prompt"
                d="M3.6 8.6 7.6 12l-4 3.4"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2.4"
            />
            <g className="command-hop">
                <g className="command-squash" style={pivotOnSelf('center bottom')}>
                    <rect height="8.5" rx="1.8" width="7" x="11" y="9.5" />
                    <g className="glyph-blink" style={pivotAt(14.5, 12.6)}>
                        <ellipse cx="13.2" cy="12.6" fill={GLYPH_CUTOUT} rx=".7" ry=".95" />
                        <ellipse cx="15.8" cy="12.6" fill={GLYPH_CUTOUT} rx=".7" ry=".95" />
                    </g>
                </g>
            </g>
            <circle
                className="command-dust"
                cx="10.6"
                cy="17.6"
                r=".75"
                style={{ '--drift': '-2px' } as CSSProperties}
            />
            <circle
                className="command-dust"
                cx="18.4"
                cy="17.6"
                r=".75"
                style={{ '--drift': '2px' } as CSSProperties}
            />
        </GlyphFrame>
    );
}
