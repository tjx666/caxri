import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame } from '../glyph-frame';
import { pivotOnSelf } from '../glyph-geometry';

/**
 * Stopping background work: a candle flame flickers, gets puffed out into a curl of smoke, then relights.
 */
export function StopGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            <rect height="10.6" rx="1.6" width="8" x="8" y="11.4" />
            <path d="M12 11.4V9.6" stroke="currentColor" strokeLinecap="round" strokeWidth="1" />
            <g className="stop-flame" style={pivotOnSelf('center bottom')}>
                <path
                    d="M12 1.6c2 2.4 3 4.1 3 5.6a3 3 0 0 1-6 0c0-1.5 1-3.2 3-5.6z"
                    fill="var(--warning)"
                />
            </g>
            <path
                className="stop-smoke"
                d="M12 9.4c-1.6-1.6 1.6-2.6 0-4.4s1.2-2.6 0-4"
                fill="none"
                pathLength="1"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="1"
            />
            <g className="stop-puff">
                <circle cx="3.2" cy="6.4" opacity=".7" r="1.4" />
                <circle cx="5.8" cy="7" opacity=".5" r="1" />
            </g>
        </GlyphFrame>
    );
}
