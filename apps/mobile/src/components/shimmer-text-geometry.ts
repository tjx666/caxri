/**
 * One sweep of the highlight across live text, matching Desktop's `--motion-activity-shimmer`.
 */
export const SHIMMER_SWEEP_MS = 2200;

/**
 * Desktop's `.activity-shimmer` paints a `300%`-wide gradient whose foreground peak sits at its middle and fades to the
 * resting color 10% to either side, then slides it from `background-position: 100%` to `0`. Measured against the text,
 * the peak travels from half a width before the text to half a width past it, and the band reaches 0.3 of a width to
 * either side of the peak. The phone reproduces those proportions so a sweep reads the same on both clients.
 */
const PEAK_START = -0.5;
const PEAK_TRAVEL = 2;
const HALF_BAND = 0.3;

/**
 * React Native cannot clip a gradient to glyphs without a masking view, so the phone approximates the band's linear
 * falloff with nested windows over a highlighted copy of the text: each narrower window adds one step of opacity.
 */
const BAND_STEPS = 4;

export interface ShimmerBandLayer {
    /**
     * Half the window's width, in points.
     */
    halfWidth: number;
    opacity: number;
}

/**
 * The windows that together draw the band, widest first. Stacking `k` of them must read as `k / BAND_STEPS` of the
 * highlight, so each layer's own opacity is `1 / (steps - k + 1)`: over the `k - 1` layers below it, which already show
 * `(k - 1) / steps`, it closes `1 / (steps - k + 1)` of the remaining gap.
 */
export function shimmerBandLayers(width: number): ShimmerBandLayer[] {
    if (width <= 0) return [];
    return Array.from({ length: BAND_STEPS }, (_, index) => ({
        halfWidth: (HALF_BAND * width * (BAND_STEPS - index)) / BAND_STEPS,
        opacity: 1 / (BAND_STEPS - index),
    }));
}

/**
 * Where a window of `halfWidth` starts, in points from the text's left edge, at `progress` (0 to 1) through a sweep.
 */
export function shimmerWindowOffset(progress: number, width: number, halfWidth: number): number {
    'worklet';
    return width * (PEAK_START + PEAK_TRAVEL * progress) - halfWidth;
}

/**
 * The highlight a stack of layers shows at `distance` points from the peak: the composited opacity of every window that
 * covers it. Exposed so the approximation can be checked against Desktop's linear falloff.
 */
export function shimmerCoverage(layers: readonly ShimmerBandLayer[], distance: number): number {
    return layers
        .filter((layer) => Math.abs(distance) < layer.halfWidth)
        .reduce((shown, layer) => shown + (1 - shown) * layer.opacity, 0);
}
