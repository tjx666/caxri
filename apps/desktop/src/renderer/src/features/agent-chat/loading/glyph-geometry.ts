import type { CSSProperties } from 'react';

/**
 * The color a glyph cuts its eyes, page lines, and seams with: the transcript's own background, so a cutout reads as a
 * hole in a 16px filled shape without an SVG mask per part.
 */
export const GLYPH_CUTOUT = 'var(--background)';

/**
 * Turns a part around a point of the 24-unit view box, for a part that pivots on a joint: a pen on its nib, a wand on
 * its handle. Every other part turns around its own box (`loading.css`).
 */
export function pivotAt(x: number, y: number): CSSProperties {
    return { transformBox: 'view-box', transformOrigin: `${x}px ${y}px` };
}

/**
 * Squashes or pops a part from an edge of its own box instead of its center, so a landing squashes against the floor.
 */
export function pivotOnSelf(origin: string): CSSProperties {
    return { transformBox: 'fill-box', transformOrigin: origin };
}

/**
 * The index a keyframe delay staggers by (`calc(var(--i) * 0.2s)`), so a row of parts moves one after another.
 */
export function staggerIndex(index: number): CSSProperties {
    return { '--i': index } as CSSProperties;
}

/**
 * A four-point sparkle centered on (`cx`, `cy`) with arm length `radius`. `pinch` is how far the curves bow toward the
 * center: smaller is a thinner star.
 */
export function sparklePath(cx: number, cy: number, radius: number, pinch = 0.16): string {
    const bow = pinch * radius;
    return [
        `M${cx} ${cy - radius}`,
        `Q${cx + bow} ${cy - bow} ${cx + radius} ${cy}`,
        `Q${cx + bow} ${cy + bow} ${cx} ${cy + radius}`,
        `Q${cx - bow} ${cy + bow} ${cx - radius} ${cy}`,
        `Q${cx - bow} ${cy - bow} ${cx} ${cy - radius}Z`,
    ].join('');
}

/**
 * Cursive handwriting ending at the pen tip: one loop every 5 units, `loops` of them to the tip's left at `height`
 * times the base loop height. The trail scrolls left one loop per cycle, so it reads as endless writing.
 */
export function cursivePath(tipX: number, tipY: number, loops: number, height: number): string {
    const start = tipX - loops * 5;
    let path = `M${start} ${tipY}`;
    for (let loop = 0; loop <= loops; loop += 1) {
        const x = start + loop * 5;
        path += ` C${x + 1.5} ${tipY} ${x + 3.5} ${tipY - 1.2 * height} ${x + 3.4} ${tipY - 2.6 * height}`;
        path += ` C${x + 3.3} ${tipY - 3.6 * height} ${x + 2} ${tipY - 3.6 * height} ${x + 2} ${tipY - 2.4 * height}`;
        path += ` C${x + 2} ${tipY - 0.8 * height} ${x + 3.8} ${tipY} ${x + 5} ${tipY}`;
    }
    return path;
}

/**
 * An SVG `id` from `useId()`, which may contain characters (`:`, `«`) that break a `url(#id)` reference.
 */
export function svgId(reactId: string): string {
    return `glyph-${reactId.replaceAll(/[^\w-]/g, '')}`;
}
