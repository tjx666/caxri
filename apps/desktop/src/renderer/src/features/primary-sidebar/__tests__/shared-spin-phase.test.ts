import { describe, expect, it, vi } from 'vitest';

import { isOnSharedPhase, sharedPhaseStartTime, syncSpinPhase } from '../shared-spin-phase';

/**
 * The angle in turns that an animation started at `startTime` shows at `time`.
 */
function phaseAt(startTime: number, time: number, period: number): number {
    return ((time - startTime) % period) / period;
}

interface FakeAnimation {
    effect: { getComputedTiming: () => { duration: number } };
    startTime: number | null;
    timeline: { currentTime: number };
}

function fakeAnimation(
    currentTime: number,
    period: number,
    startTime: number | null,
): FakeAnimation {
    return {
        effect: { getComputedTiming: () => ({ duration: period }) },
        startTime,
        timeline: { currentTime },
    };
}

function fakeRing(animations: FakeAnimation[]) {
    const target = new EventTarget();
    return Object.assign(target, { getAnimations: () => animations }) as unknown as HTMLElement &
        EventTarget;
}

describe('sharedPhaseStartTime', () => {
    it('gives rings mounted at different moments the same angle at every later moment', () => {
        const period = 1000;
        const first = sharedPhaseStartTime(12_340, period);
        const second = sharedPhaseStartTime(12_840, period);
        if (first === null || second === null) throw new Error('Expected aligned start times');
        for (const time of [12_900, 13_005, 14_777]) {
            expect(phaseAt(second, time, period)).toBeCloseTo(phaseAt(first, time, period));
        }
    });

    it('starts a new ring at the current shared angle instead of at zero', () => {
        const startTime = sharedPhaseStartTime(12_250, 1000);
        if (startTime === null) throw new Error('Expected an aligned start time');
        expect(startTime).toBeLessThanOrEqual(12_250);
        expect(phaseAt(startTime, 12_250, 1000)).toBeCloseTo(0.25);
    });

    it('keeps each period on its own phase', () => {
        expect(sharedPhaseStartTime(7500, 1000)).toBe(7000);
        expect(sharedPhaseStartTime(7500, 3000)).toBe(6000);
    });

    it('rejects inputs that cannot define a phase', () => {
        expect(sharedPhaseStartTime(NaN, 1000)).toBeNull();
        expect(sharedPhaseStartTime(1000, 0)).toBeNull();
        expect(sharedPhaseStartTime(1000, Infinity)).toBeNull();
    });
});

describe('isOnSharedPhase', () => {
    it('accepts whole-period start times within float tolerance', () => {
        expect(isOnSharedPhase(9000, 3000)).toBe(true);
        expect(isOnSharedPhase(8999.9, 3000)).toBe(true);
        expect(isOnSharedPhase(-3000, 3000)).toBe(true);
        expect(isOnSharedPhase(9100, 3000)).toBe(false);
    });
});

describe('syncSpinPhase', () => {
    it('aligns the ring on mount and again when motion restarts its animation', () => {
        const animation = fakeAnimation(12_250, 1000, 12_250);
        const ring = fakeRing([animation]);
        const cleanup = syncSpinPhase(ring);
        expect(animation.startTime).toBe(12_000);

        Object.assign(animation, { startTime: 15_400, timeline: { currentTime: 15_400 } });
        ring.dispatchEvent(new Event('animationstart'));
        expect(animation.startTime).toBe(15_000);

        cleanup?.();
        animation.startTime = 16_200;
        ring.dispatchEvent(new Event('animationstart'));
        expect(animation.startTime).toBe(16_200);
    });

    it('leaves an already aligned ring untouched so its compositor animation is not restarted', () => {
        const animation = fakeAnimation(20_500, 1000, 3000);
        const setStartTime = vi.fn();
        Object.defineProperty(animation, 'startTime', { get: () => 3000, set: setStartTime });
        syncSpinPhase(fakeRing([animation]));
        expect(setStartTime).not.toHaveBeenCalled();
    });

    it('does nothing for a ring without animations, as under reduced motion', () => {
        expect(() => syncSpinPhase(fakeRing([]))).not.toThrow();
        expect(syncSpinPhase(null)).toBeUndefined();
    });
});
