import { describe, expect, it } from 'vitest';

import { shimmerBandLayers, shimmerCoverage, shimmerWindowOffset } from '../shimmer-text-geometry';

describe('shimmer geometry', () => {
    it('steps the band down linearly from full highlight at the peak to none at its edge', () => {
        const layers = shimmerBandLayers(200);
        // The band reaches 0.3 of the width (60 points) to either side, as Desktop's gradient does.
        expect(layers[0]?.halfWidth).toBe(60);
        expect(shimmerCoverage(layers, 0)).toBeCloseTo(1);
        expect(shimmerCoverage(layers, 20)).toBeCloseTo(0.75);
        expect(shimmerCoverage(layers, 35)).toBeCloseTo(0.5);
        expect(shimmerCoverage(layers, 50)).toBeCloseTo(0.25);
        expect(shimmerCoverage(layers, 61)).toBe(0);
    });

    it('sweeps the peak from half a width before the text to half a width past it', () => {
        const halfWidth = Math.max(...shimmerBandLayers(100).map((layer) => layer.halfWidth));
        expect(shimmerWindowOffset(0, 100, halfWidth) + halfWidth).toBe(-50);
        expect(shimmerWindowOffset(1, 100, halfWidth) + halfWidth).toBe(150);
    });

    it('draws nothing before the text has a width', () => {
        expect(shimmerBandLayers(0)).toEqual([]);
    });
});
