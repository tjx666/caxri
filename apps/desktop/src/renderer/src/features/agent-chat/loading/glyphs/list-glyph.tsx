import type { CSSProperties } from 'react';

import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame } from '../glyph-frame';
import { GLYPH_CUTOUT, pivotOnSelf, staggerIndex } from '../glyph-geometry';

const PAPERS = [
    { cx: 7.5, tilt: '-16deg' },
    { cx: 12, tilt: '6deg' },
    { cx: 16.5, tilt: '18deg' },
] as const;

/**
 * Listing: folder popcorn. Files pop out of an open folder one after another and drop back in.
 */
export function ListGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            <path
                d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l1.6 1.8h8.7a1.5 1.5 0 0 1 1.5 1.5v8.4a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3 17.7z"
                opacity=".55"
            />
            {PAPERS.map((paper, index) => (
                <rect
                    className="list-paper"
                    height="4.6"
                    key={paper.cx}
                    rx=".7"
                    stroke={GLYPH_CUTOUT}
                    strokeWidth=".8"
                    style={
                        {
                            ...pivotOnSelf('center bottom'),
                            ...staggerIndex(index),
                            '--tilt': paper.tilt,
                        } as CSSProperties
                    }
                    width="3.4"
                    x={paper.cx - 1.7}
                    y="8.4"
                />
            ))}
            <path
                className="list-lid"
                d="M2.6 11.2h18.8l-.9 6.4a1.5 1.5 0 0 1-1.5 1.3H5a1.5 1.5 0 0 1-1.5-1.3z"
                stroke={GLYPH_CUTOUT}
                strokeWidth=".9"
                style={pivotOnSelf('center bottom')}
            />
        </GlyphFrame>
    );
}
