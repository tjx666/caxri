import './loading.css';

import type { ReactNode } from 'react';
import { useId } from 'react';

import { cn } from '../../../lib/utilities';
import { svgId } from './glyph-geometry';

export interface GlyphProperties {
    /**
     * Rendered width and height in pixels; the drawing is on a 24-unit grid.
     */
    size?: number;
}

/**
 * The SVG a live tool glyph draws in: a 24-unit filled drawing in the text color that may move past its box (a hop, a
 * pop), so it never clips its own motion.
 */
export function GlyphFrame({
    children,
    className,
    size = 16,
}: GlyphProperties & { children: ReactNode; className?: string }) {
    return (
        <svg
            aria-hidden="true"
            className={cn('agent-chat-glyph shrink-0 overflow-visible', className)}
            fill="currentColor"
            height={size}
            viewBox="0 0 24 24"
            width={size}
        >
            {children}
        </svg>
    );
}

/**
 * Melts overlapping shapes into one gooey blob (blur, then a hard alpha threshold), so a satellite merging into a core
 * or a bud splitting off reads as liquid instead of two circles crossing.
 */
export function GooGroup({ blur = 1.1, children }: { blur?: number; children: ReactNode }) {
    const id = svgId(useId());
    return (
        <>
            <defs>
                <filter height="300%" id={id} width="300%" x="-100%" y="-100%">
                    <feGaussianBlur in="SourceGraphic" result="blur" stdDeviation={blur} />
                    <feColorMatrix
                        in="blur"
                        values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"
                    />
                </filter>
            </defs>
            <g filter={`url(#${id})`}>{children}</g>
        </>
    );
}
