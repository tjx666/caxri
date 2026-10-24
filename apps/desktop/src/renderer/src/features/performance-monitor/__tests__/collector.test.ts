import { describe, expect, it, vi } from 'vitest';

import type { CollectorEnvironment } from '../collector';
import { PerformanceCollector } from '../collector';

function fakeEnvironment() {
    let clock = 0;
    let pending: ((timestamp: number) => void) | undefined;
    let longFrame: ((durationMs: number) => void) | undefined;
    const disconnect = vi.fn();
    const environment: CollectorEnvironment = {
        cancelFrame: vi.fn(() => {
            pending = undefined;
        }),
        heap: () => ({ limit: 4 * 1024 * 1024 * 1024, used: 100 * 1024 * 1024 }),
        isVisible: () => true,
        now: () => clock,
        observeLongFrames: (listener) => {
            longFrame = listener;
            return disconnect;
        },
        onVisibilityChange: () => () => {},
        requestFrame: (callback) => {
            pending = callback;
            return 1;
        },
    };
    return {
        disconnect,
        environment,
        frame(ms: number) {
            clock += ms;
            const callback = pending;
            pending = undefined;
            callback?.(clock);
        },
        hasPendingFrame: () => pending !== undefined,
        longFrame: (ms: number) => longFrame?.(ms),
    };
}

describe('PerformanceCollector', () => {
    it('owns no frame request until someone subscribes and releases it with the last subscriber', () => {
        const fake = fakeEnvironment();
        const collector = new PerformanceCollector(fake.environment);
        expect(fake.hasPendingFrame()).toBe(false);
        const first = collector.acquire();
        const second = collector.acquire();
        expect(fake.hasPendingFrame()).toBe(true);
        first();
        first();
        expect(collector.isRunning()).toBe(true);
        second();
        expect(collector.isRunning()).toBe(false);
        expect(fake.hasPendingFrame()).toBe(false);
        expect(fake.disconnect).toHaveBeenCalledTimes(1);
    });

    it('derives fps, heap and long frames into a snapshot', () => {
        const fake = fakeEnvironment();
        const collector = new PerformanceCollector(fake.environment);
        collector.acquire();
        for (let index = 0; index < 30; index += 1) fake.frame(16);
        fake.longFrame(120);
        const snapshot = collector.snapshot();
        expect(snapshot.fps).toBeCloseTo(62.5, 1);
        expect(snapshot.frameMs.length).toBeGreaterThan(20);
        expect(snapshot.longFrameCount).toBe(1);
        expect(snapshot.lastLongFrameMs).toBe(120);
        expect(snapshot.jsHeapUsedMb).toBeCloseTo(100, 1);
        expect(snapshot.lastSessionSwitchMs).toBeNull();
    });
});
