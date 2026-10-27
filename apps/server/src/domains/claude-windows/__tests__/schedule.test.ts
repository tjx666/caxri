import process from 'node:process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    anchorMinuteOfDay,
    dailyWakeTimes,
    decide,
    isEndingBeforeNextAnchor,
    nextAnchor,
    nextCheckAt,
    previousAnchor,
} from '../schedule';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const TEN = 600;
const originalTimeZone = process.env.TZ;

function local(text: string): number {
    return new Date(text).getTime();
}

function useTimeZone(zone: string): void {
    process.env.TZ = zone;
}

beforeEach(() => useTimeZone('Asia/Shanghai'));
afterEach(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
});

describe('morning anchor', () => {
    it('puts the default 10:00 workday reset at a 05:00 anchor', () => {
        expect(anchorMinuteOfDay(TEN)).toBe(300);
        expect(nextAnchor(local('2026-10-26T04:00:00'), TEN)).toBe(local('2026-10-26T05:00:00'));
        expect(nextAnchor(local('2026-10-26T05:00:00'), TEN)).toBe(local('2026-10-27T05:00:00'));
        expect(previousAnchor(local('2026-10-26T05:00:00'), TEN)).toBe(
            local('2026-10-26T05:00:00'),
        );
        expect(previousAnchor(local('2026-10-26T04:59:00'), TEN)).toBe(
            local('2026-10-25T05:00:00'),
        );
    });

    it('follows a custom time, including one whose anchor falls on the previous evening', () => {
        expect(anchorMinuteOfDay(8 * 60 + 30)).toBe(3 * 60 + 30);
        expect(anchorMinuteOfDay(2 * 60)).toBe(21 * 60);
        expect(nextAnchor(local('2026-10-26T12:00:00'), 2 * 60)).toBe(local('2026-10-26T21:00:00'));
    });

    it('recomputes each day on the local wall clock across a DST change', () => {
        useTimeZone('America/New_York');
        // Clocks go back on 2026-11-01: the anchor stays at 05:00 local, 25 hours after the previous one.
        const before = nextAnchor(local('2026-10-31T06:00:00'), TEN);
        expect(new Date(before).getHours()).toBe(5);
        expect(before - local('2026-10-31T05:00:00')).toBe(25 * HOUR);
        // Clocks go forward on 2026-03-08 at 02:00: an anchor at 02:30 does not exist and moves to 03:30.
        const skipped = nextAnchor(local('2026-03-08T00:00:00'), 7 * 60 + 30);
        expect(new Date(skipped).getHours()).toBe(3);
        expect(new Date(skipped).getDate()).toBe(8);
    });

    it('follows a time zone change at the next computation', () => {
        const instant = Date.UTC(2026, 9, 26, 0, 0);
        const shanghai = nextAnchor(instant, TEN);
        useTimeZone('Europe/London');
        const london = nextAnchor(instant, TEN);
        expect(new Date(shanghai).toISOString()).toBe('2026-10-26T21:00:00.000Z');
        expect(new Date(london).toISOString()).toBe('2026-10-26T05:00:00.000Z');
    });
});

describe('daily realignment', () => {
    it('renews only windows that end by the next anchor', () => {
        expect(isEndingBeforeNextAnchor(local('2026-10-26T15:00:00'), TEN)).toBe(true);
        expect(isEndingBeforeNextAnchor(local('2026-10-27T00:00:00'), TEN)).toBe(true);
        expect(isEndingBeforeNextAnchor(local('2026-10-27T01:00:00'), TEN)).toBe(false);
    });

    it('wakes the background job at the anchor and at each renewal of the anchored chain', () => {
        expect(dailyWakeTimes(TEN)).toEqual([
            { hour: 5, minute: 0 },
            { hour: 10, minute: 1 },
            { hour: 15, minute: 1 },
            { hour: 20, minute: 1 },
        ]);
        expect(dailyWakeTimes(60)).toEqual([
            { hour: 20, minute: 0 },
            { hour: 1, minute: 1 },
            { hour: 6, minute: 1 },
            { hour: 11, minute: 1 },
        ]);
    });
});

describe('decide', () => {
    const idle = { isWeeklyLimitReached: false };

    it('starts a window at the anchor, then renews at each reset until a renewal would cover the next anchor', () => {
        const anchor = local('2026-10-26T05:00:00');
        expect(decide(anchor, TEN, idle, {})).toEqual({
            kind: 'trigger',
            due: { plannedAt: anchor, reason: 'anchor', isMissed: false },
        });
        const ten = local('2026-10-26T10:00:00');
        const memory = { processedThroughAt: anchor, observedResetAt: ten };
        expect(decide(ten + MINUTE, TEN, idle, memory)).toMatchObject({
            kind: 'trigger',
            due: { plannedAt: ten, reason: 'renewal', isMissed: false },
        });
        const night = local('2026-10-27T01:00:00');
        expect(
            decide(night + MINUTE, TEN, idle, {
                processedThroughAt: local('2026-10-26T20:00:00'),
                observedResetAt: night,
            }),
        ).toMatchObject({ kind: 'skipRenewal', due: { plannedAt: night } });
    });

    it('is idempotent: a spent window is never due again', () => {
        const anchor = local('2026-10-26T05:00:00');
        expect(decide(anchor + 2 * MINUTE, TEN, idle, { processedThroughAt: anchor })).toEqual({
            kind: 'idle',
        });
    });

    it('lets a real request win and spends the due window without sending', () => {
        const anchor = local('2026-10-26T05:00:00');
        const resetsAt = local('2026-10-26T09:00:00');
        expect(decide(anchor + MINUTE, TEN, { ...idle, windowResetsAt: resetsAt }, {})).toEqual({
            kind: 'active',
            resetsAt,
            renews: true,
            naturalFor: { plannedAt: anchor, reason: 'anchor', isMissed: false },
        });
    });

    it('says whether an active window is renewed when it resets', () => {
        const now = local('2026-10-26T22:00:00');
        expect(
            decide(
                now,
                TEN,
                { ...idle, windowResetsAt: local('2026-10-27T00:30:00') },
                {
                    processedThroughAt: now,
                },
            ),
        ).toEqual({ kind: 'active', resetsAt: local('2026-10-27T00:30:00'), renews: false });
    });

    it('reconciles a missed anchor once after waking, and not after its window would have ended', () => {
        const anchor = local('2026-10-26T05:00:00');
        expect(decide(local('2026-10-26T07:30:00'), TEN, idle, {})).toMatchObject({
            kind: 'trigger',
            due: { plannedAt: anchor, isMissed: true },
        });
        expect(
            decide(local('2026-10-26T07:31:00'), TEN, idle, { processedThroughAt: anchor }),
        ).toEqual({
            kind: 'idle',
        });
        expect(decide(local('2026-10-26T10:30:00'), TEN, idle, {})).toEqual({ kind: 'idle' });
    });

    it('spends several missed times with one check: the latest wins', () => {
        const memory = {
            processedThroughAt: local('2026-10-26T20:00:00'),
            observedResetAt: local('2026-10-27T01:00:00'),
        };
        expect(decide(local('2026-10-27T06:00:00'), TEN, idle, memory)).toMatchObject({
            kind: 'trigger',
            due: { plannedAt: local('2026-10-27T05:00:00'), reason: 'anchor', isMissed: true },
        });
    });

    it('ignores a reset older than the latest anchor', () => {
        expect(
            decide(local('2026-10-26T14:00:00'), TEN, idle, {
                processedThroughAt: local('2026-10-24T05:00:00'),
                observedResetAt: local('2026-10-24T15:00:00'),
            }),
        ).toEqual({ kind: 'idle' });
    });

    it('waits on a used-up weekly limit without spending the window', () => {
        const anchor = local('2026-10-26T05:00:00');
        expect(decide(anchor, TEN, { isWeeklyLimitReached: true }, {})).toMatchObject({
            kind: 'weeklyLimit',
            due: { plannedAt: anchor },
        });
    });
});

describe('nextCheckAt', () => {
    it('looks again a minute after the active window resets, then at the next anchor, capped by the maximum delay', () => {
        const now = local('2026-10-26T11:00:00');
        expect(nextCheckAt(now, TEN, local('2026-10-26T15:00:00'), 8 * HOUR)).toBe(
            local('2026-10-26T15:01:00'),
        );
        expect(nextCheckAt(now, TEN, undefined, 24 * HOUR)).toBe(local('2026-10-27T05:00:00'));
        expect(nextCheckAt(now, TEN, undefined, HOUR)).toBe(now + HOUR);
    });
});
