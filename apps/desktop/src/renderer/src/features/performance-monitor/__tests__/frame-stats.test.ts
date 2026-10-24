import { describe, expect, it } from 'vitest';

import { formatFps } from '../format';
import { computeFrameStats, FrameRing } from '../frame-stats';

function ringWithCadence(frames: number, intervalMs: number, start = 0): FrameRing {
    const ring = new FrameRing(240);
    for (let index = 0; index < frames; index += 1) ring.push(start + index * intervalMs);
    return ring;
}

describe('computeFrameStats', () => {
    it('reads a steady 14.37 ms cadence as 69.6 fps', () => {
        const ring = ringWithCadence(60, 1_000 / 69.6);
        const now = ring.at(0)!;
        const stats = computeFrameStats(ring, now);
        expect(formatFps(stats.fps)).toBe('69.6');
        expect(formatFps(stats.minFps)).toBe('69.6');
    });

    it('reports a dropped frame in min and 1% low but barely in fps', () => {
        const ring = ringWithCadence(30, 16);
        ring.push(ring.at(0)! + 100);
        const stats = computeFrameStats(ring, ring.at(0)!);
        expect(stats.minFps).toBeCloseTo(10, 5);
        expect(stats.lowFps).toBeCloseTo(10, 5);
        expect(stats.fps).toBeGreaterThan(40);
    });

    it('treats a stale or tiny history as no signal', () => {
        const ring = ringWithCadence(10, 16);
        expect(computeFrameStats(ring, ring.at(0)! + 5_000).fps).toBe(0);
        const single = new FrameRing(4);
        single.push(1);
        expect(computeFrameStats(single, 1).fps).toBe(0);
    });
});

describe('FrameRing', () => {
    it('overwrites the oldest entry at capacity and lists intervals oldest first', () => {
        const ring = new FrameRing(3);
        for (const timestamp of [0, 10, 30, 60]) ring.push(timestamp);
        expect(ring.length).toBe(3);
        expect(ring.intervals()).toEqual([20, 30]);
        expect(ring.at(3)).toBeUndefined();
    });
});
