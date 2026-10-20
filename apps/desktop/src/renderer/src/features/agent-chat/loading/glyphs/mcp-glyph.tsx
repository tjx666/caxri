import type { GlyphProperties as GlyphProperties } from '../glyph-frame';
import { GlyphFrame } from '../glyph-frame';
import { GLYPH_CUTOUT, sparklePath } from '../glyph-geometry';

/**
 * Calling an MCP tool: two puzzle halves glide together, snap, and a spark pops at the seam.
 */
export function McpGlyph({ size }: GlyphProperties) {
    return (
        <GlyphFrame size={size}>
            <g className="mcp-right">
                <rect height="9" rx="1.8" width="10" x="11.6" y="7.5" />
                <circle cx="11.9" cy="12" fill={GLYPH_CUTOUT} r="2.4" />
            </g>
            <g className="mcp-left">
                <rect height="9" rx="1.8" width="9.6" x="2.4" y="7.5" />
                <circle cx="12.1" cy="12" r="1.9" />
            </g>
            <path className="mcp-spark" d={sparklePath(12, 3.6, 2.6, 0.2)} fill="var(--merged)" />
        </GlyphFrame>
    );
}
