/**
 * One sweep of the highlight across live text, matching Desktop's `--motion-activity-shimmer`.
 */
export const SHIMMER_SWEEP_MS = 2200;

/**
 * Desktop's `.activity-shimmer` paints a gradient three times the text's width (resting color to 40%, the foreground at
 * 50%, resting color again from 60%) and slides it from `background-position: 100%` to `0`. The phone draws the same
 * gradient, so a sweep reads identically on both clients: the peak travels from half a width before the text to half a
 * width past it, and fades out 0.3 of a width to either side.
 */
export const SHIMMER_GRADIENT_SCALE = 3;

/**
 * The highlight's opacity stops along the gradient, as offsets of its full width. Between stops SVG interpolates per
 * pixel, which is what keeps the band free of the visible steps a stack of discrete layers produces.
 */
export const SHIMMER_GRADIENT_STOPS = [
    { offset: 0, opacity: 0 },
    { offset: 0.4, opacity: 0 },
    { offset: 0.5, opacity: 1 },
    { offset: 0.6, opacity: 0 },
    { offset: 1, opacity: 0 },
] as const;

/**
 * Where the gradient's left edge sits, in points from the text's left edge, at `progress` (0 to 1) through a sweep:
 * `background-position: 100%` aligns its right edge with the text's (two widths to the left), `0` its left edge.
 */
export function shimmerGradientOffset(progress: number, width: number): number {
    'worklet';
    return -(SHIMMER_GRADIENT_SCALE - 1) * width * (1 - progress);
}
