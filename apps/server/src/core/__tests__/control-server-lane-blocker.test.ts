import { describe, expect, it } from 'vitest';

import type { LaneHold } from '../control-server-lane';
import { attributeLaneBlocker, ControlConnectionLanes, LaneRegistry } from '../control-server-lane';
import type { OrderedQueueTiming } from '../control-server-support';

function hold(overrides: Partial<LaneHold> & Pick<LaneHold, 'method' | 'startedAt' | 'endedAt'>) {
    return { lane: 'ordered' as const, requestId: `${overrides.method}-id`, ...overrides };
}

describe('lane blocker attribution', () => {
    it('names the holder that overlapped the wait the longest, not the latest or the longest overall', () => {
        const holds = [
            hold({ method: 'earlier.huge', startedAt: 0, endedAt: 400 }),
            hold({ method: 'git.sync', startedAt: 400, endedAt: 1400 }),
            hold({ method: 'session.save', startedAt: 1400, endedAt: 1450 }),
        ];

        expect(
            attributeLaneBlocker(holds, {
                admittedAt: 1450,
                enqueuedAt: 500,
                lane: 'ordered',
                startedAt: 1450,
            }),
        ).toEqual({ method: 'git.sync', overlapMs: 900, requestId: 'git.sync-id' });
    });

    it('returns nothing when no recorded hold overlaps the wait', () => {
        const holds = [hold({ method: 'old', startedAt: 0, endedAt: 100 })];

        expect(
            attributeLaneBlocker(holds, {
                admittedAt: 900,
                enqueuedAt: 200,
                lane: 'ordered',
                startedAt: 900,
            }),
        ).toBeUndefined();
    });

    it('lets a repository lane hold delay a repository request but not an ordered one', () => {
        const holds = [
            hold({ lane: 'repository', method: 'git.sync', startedAt: 0, endedAt: 900 }),
        ];
        const wait = { admittedAt: 100, enqueuedAt: 100, startedAt: 900 };

        expect(attributeLaneBlocker(holds, { ...wait, lane: 'ordered' })).toBeUndefined();
        expect(attributeLaneBlocker(holds, { ...wait, lane: 'repository' })?.method).toBe(
            'git.sync',
        );
    });
});

function timingFor(enqueuedAt: number): OrderedQueueTiming {
    return { enqueuedAt, queueDepth: 1 };
}

describe('lane blocker admission window', () => {
    it('ignores ordered holds that started after a repository request was admitted', () => {
        const holds = [
            hold({ method: 'before.admission', startedAt: 0, endedAt: 300 }),
            hold({ method: 'after.admission', startedAt: 300, endedAt: 2000 }),
            hold({ lane: 'repository', method: 'git.sync', startedAt: 300, endedAt: 700 }),
        ];

        expect(
            attributeLaneBlocker(holds, {
                admittedAt: 300,
                enqueuedAt: 0,
                lane: 'repository',
                startedAt: 700,
            }),
        ).toMatchObject({ method: 'git.sync', overlapMs: 400 });
    });
});

describe('ControlConnectionLanes blocker annotation', () => {
    it('blames the ordered write that held the lane and never a read that left it', async () => {
        const lanes = new ControlConnectionLanes(() => {}, new LaneRegistry());
        const seen = new Map<string, OrderedQueueTiming>();
        const dispatch = (id: string, durationMs: number) => async (timing: OrderedQueueTiming) => {
            seen.set(id, timing);
            await new Promise((resolve) => setTimeout(resolve, durationMs));
        };
        const enqueuedAt = performance.now();

        // `terminal.resources` is a concurrent read: it settles outside the ordered lane right after admission.
        const read = lanes.settle(
            { id: 'r1', method: 'terminal.resources' },
            timingFor(enqueuedAt),
            dispatch('r1', 0),
            'command-dispatch-failed',
        );
        const slowWrite = lanes.settle(
            { id: 'w1', method: 'files.write' },
            timingFor(enqueuedAt),
            dispatch('w1', 180),
            'command-dispatch-failed',
        );
        await Promise.all([read, slowWrite]);
        // The next request was queued while `w1` held the lane.
        await lanes.settle(
            { id: 's1', method: 'session.select' },
            timingFor(enqueuedAt),
            dispatch('s1', 0),
            'command-dispatch-failed',
        );

        expect(seen.get('r1')?.blockedBy).toBeUndefined();
        expect(seen.get('s1')?.blockedBy).toMatchObject({ method: 'files.write', requestId: 'w1' });
        expect(seen.get('s1')?.blockedBy?.overlapMs).toBeGreaterThan(100);
    });

    it('does not annotate a wait below the attribution floor', async () => {
        const lanes = new ControlConnectionLanes(() => {}, new LaneRegistry());
        let timing: OrderedQueueTiming | undefined;
        await lanes.settle(
            { id: 'a', method: 'files.write' },
            timingFor(performance.now()),
            () => Promise.resolve(),
            'command-dispatch-failed',
        );
        await lanes.settle(
            { id: 'b', method: 'session.select' },
            timingFor(performance.now()),
            (laneTiming) => {
                timing = laneTiming;
                return Promise.resolve();
            },
            'command-dispatch-failed',
        );

        expect(timing?.blockedBy).toBeUndefined();
    });
});
