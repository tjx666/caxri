import { describe, expect, it } from 'vitest';

import { SessionHeatTracker } from '../session-heat';

const THRESHOLDS = { coolCpuPercent: 70, coolMs: 20_000, cpuPercent: 100, sustainMs: 60_000 };

function readings(entries: Record<string, number>): Map<string, number> {
    return new Map(Object.entries(entries));
}

describe('SessionHeatTracker', () => {
    it('marks a Session hot only after it holds a core for the whole sustain window', () => {
        const tracker = new SessionHeatTracker(THRESHOLDS);

        expect(tracker.update(readings({ a: 150 }), 0)).toEqual([]);
        expect(tracker.update(readings({ a: 150 }), 50_000)).toEqual([]);
        expect(tracker.hot().size).toBe(0);

        expect(tracker.update(readings({ a: 186 }), 60_000)).toEqual([
            { kind: 'raised', cpuPercent: 186, sessionId: 'a' },
        ]);
        expect(tracker.hot().get('a')).toEqual({ cpuPercent: 190, since: 0 });
    });

    it('restarts the sustain window when a reading dips below the heat line', () => {
        const tracker = new SessionHeatTracker(THRESHOLDS);

        tracker.update(readings({ a: 150 }), 0);
        tracker.update(readings({ a: 90 }), 30_000);
        tracker.update(readings({ a: 150 }), 40_000);

        expect(tracker.update(readings({ a: 150 }), 70_000)).toEqual([]);
        expect(tracker.update(readings({ a: 150 }), 100_000)).toHaveLength(1);
    });

    it('stays hot between the two lines and cools only after the cool window below the lower one', () => {
        const tracker = new SessionHeatTracker(THRESHOLDS);
        tracker.update(readings({ a: 200 }), 0);
        tracker.update(readings({ a: 200 }), 60_000);

        expect(tracker.update(readings({ a: 80 }), 70_000)).toEqual([]);
        expect(tracker.update(readings({ a: 40 }), 80_000)).toEqual([]);
        expect(tracker.update(readings({ a: 75 }), 90_000)).toEqual([]);
        expect(tracker.update(readings({ a: 40 }), 100_000)).toEqual([]);
        expect(tracker.update(readings({ a: 40 }), 120_000)).toEqual([
            {
                durationMs: 120_000,
                kind: 'cleared',
                peakCpuPercent: 200,
                reason: 'recovered',
                sessionId: 'a',
            },
        ]);
        expect(tracker.hot().size).toBe(0);
        expect(tracker.isTracking()).toBe(false);
    });

    it('clears a hot Session as stopped once nothing of it runs', () => {
        const tracker = new SessionHeatTracker(THRESHOLDS);
        tracker.update(readings({ a: 200, b: 150 }), 0);
        tracker.update(readings({ a: 200, b: 150 }), 60_000);

        expect(tracker.update(readings({ b: 150 }), 70_000)).toEqual([
            expect.objectContaining({ kind: 'cleared', reason: 'stopped', sessionId: 'a' }),
        ]);
        expect(tracker.hot().keys().toArray()).toEqual(['b']);
    });

    it('forgets a warming Session that stops before it ever turned hot', () => {
        const tracker = new SessionHeatTracker(THRESHOLDS);
        tracker.update(readings({ a: 150 }), 0);

        expect(tracker.update(readings({}), 10_000)).toEqual([]);
        expect(tracker.isTracking()).toBe(false);
    });
});
