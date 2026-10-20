import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame } from '../glyph-frame';
import { GLYPH_CUTOUT, pivotAt } from '../glyph-geometry';

/**
 * Messaging or managing another Agent: a winged envelope flaps across to deliver a note.
 */
export function ManageGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            <g className="manage-letter">
                <g className="manage-wing" style={pivotAt(8, 10)}>
                    <path
                        d="M8 10C5.6 6.6 2.6 6.4 1.6 7.6c1.6.4 2.4 1.6 2.6 3.2-1 0-1.8.6-2 1.4C3.4 12.4 6 12.4 8 11.6Z"
                        opacity=".75"
                    />
                </g>
                <g className="manage-wing" style={pivotAt(16, 10)}>
                    <path
                        d="M16 10c2.4-3.4 5.4-3.6 6.4-2.4-1.6.4-2.4 1.6-2.6 3.2 1 0 1.8.6 2 1.4-1.2.2-3.8.2-5.8-.6Z"
                        opacity=".75"
                    />
                </g>
                <rect height="9.6" rx="1.4" width="12" x="6" y="8.6" />
                <path
                    d="M6.6 9.4 12 13.6l5.4-4.2"
                    fill="none"
                    stroke={GLYPH_CUTOUT}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.1"
                />
                <path
                    d="M12 14.6c-.9-.8-1.9-1.2-1.9-2.1a.95.95 0 0 1 1.9-.2.95.95 0 0 1 1.9.2c0 .9-1 1.3-1.9 2.1z"
                    fill="var(--accent)"
                />
            </g>
        </GlyphFrame>
    );
}
