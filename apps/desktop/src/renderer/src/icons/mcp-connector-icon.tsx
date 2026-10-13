import type { SVGProps } from 'react';

/**
 * The glyph an MCP tool call shows when its server has no icon of its own: four connected nodes, the shape the Codex
 * app gives an unnamed connector. Drawn on Lucide's 24px grid and stroke so it sits beside the other tool glyphs.
 */
export function McpConnectorIcon(properties: SVGProps<SVGSVGElement>) {
    return (
        <svg
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            viewBox="0 0 24 24"
            {...properties}
        >
            <circle cx="6" cy="6" r="3" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="18" r="3" />
            <path d="M15.88 8.12 8.12 15.88" />
        </svg>
    );
}
