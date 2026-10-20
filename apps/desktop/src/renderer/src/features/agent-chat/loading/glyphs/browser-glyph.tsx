import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame } from '../glyph-frame';
import { GLYPH_CUTOUT } from '../glyph-geometry';

/**
 * Driving a browser: a cursor glides to a button and clicks it; the button squashes and a ripple spreads.
 */
export function BrowserGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            <rect
                fill="none"
                height="15"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.6"
                width="18"
                x="3"
                y="4"
            />
            <path d="M3.8 7.8h16.4" stroke="currentColor" strokeWidth="1.2" />
            <circle cx="5.6" cy="6" r=".6" />
            <circle cx="7.4" cy="6" r=".6" />
            <rect className="browser-button" height="3" rx="1.5" width="7" x="6" y="12" />
            <circle
                className="browser-ripple"
                cx="9.5"
                cy="13.5"
                fill="none"
                r="2.6"
                stroke="currentColor"
                strokeWidth=".9"
            />
            <g className="browser-cursor">
                <path
                    d="M0 0 0 6.6 1.7 5.1 2.9 7.6 4.1 7 2.9 4.6H5.1Z"
                    stroke={GLYPH_CUTOUT}
                    strokeLinejoin="round"
                    strokeWidth=".8"
                />
            </g>
        </GlyphFrame>
    );
}
