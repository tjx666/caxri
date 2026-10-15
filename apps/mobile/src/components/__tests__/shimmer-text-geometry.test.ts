import { describe, expect, it } from 'vitest';

import {
    SHIMMER_GRADIENT_SCALE,
    SHIMMER_GRADIENT_STOPS,
    shimmerGradientOffset,
} from '../shimmer-text-geometry';

const peakOffset = SHIMMER_GRADIENT_STOPS.find((stop) => stop.opacity === 1)?.offset ?? 0;

/**
 * Where the highlight's peak sits relative to the text's left edge, in text widths.
 */
const peakPosition = (progress: number, width: number) =>
    (shimmerGradientOffset(progress, width) + peakOffset * SHIMMER_GRADIENT_SCALE * width) / width;

describe('shimmer geometry', () => {
    it('sweeps the peak from half a width before the text to half a width past it', () => {
        expect(peakPosition(0, 100)).toBeCloseTo(-0.5);
        expect(peakPosition(0.5, 100)).toBeCloseTo(0.5);
        expect(peakPosition(1, 100)).toBeCloseTo(1.5);
    });

    it('fades the highlight to nothing 0.3 of a width to either side of the peak, as Desktop does', () => {
        const edges = SHIMMER_GRADIENT_STOPS.filter((stop) => stop.offset > 0 && stop.offset < 1);
        const reach = edges.map((stop) => (stop.offset - peakOffset) * SHIMMER_GRADIENT_SCALE);
        expect(reach[0]).toBeCloseTo(-0.3);
        expect(reach.at(-1)).toBeCloseTo(0.3);
    });
});
