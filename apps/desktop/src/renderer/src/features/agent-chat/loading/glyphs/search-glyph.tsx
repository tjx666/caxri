import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame } from '../glyph-frame';
import { pivotAt, pivotOnSelf } from '../glyph-geometry';

/**
 * Searching: the magnifier's lens is an eye. The glass hops from side to side, squashing as it lands, while its pupil
 * darts around and blinks.
 */
export function SearchGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            <g className="search-hop-x">
                <g className="search-hop-y">
                    <g className="search-land" style={pivotOnSelf('center bottom')}>
                        <circle
                            cx="10.5"
                            cy="10"
                            fill="none"
                            r="4.6"
                            stroke="currentColor"
                            strokeWidth="2.2"
                        />
                        <path
                            d="m14 13.5 3.4 3.4"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeWidth="2.8"
                        />
                        <g className="glyph-blink" style={pivotAt(10.5, 10)}>
                            <g className="search-pupil">
                                <circle cx="10.5" cy="10" r="1.7" />
                            </g>
                        </g>
                    </g>
                </g>
            </g>
        </GlyphFrame>
    );
}
