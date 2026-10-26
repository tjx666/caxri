import { describe, expect, it, vi } from 'vitest';

import type { BackgroundLoadGate } from '../../../observability/machine-load';
import { ResidentPoll } from '../resident-poll';
import { DeliveryWatch } from '../watch';
import { logger } from './project-status.fixture';

function loadGate(isLoaded: boolean): BackgroundLoadGate & { deferred: string[] } {
    const deferred: string[] = [];
    return {
        deferred,
        shouldDefer: (source) => {
            if (isLoaded) deferred.push(source);
            return isLoaded;
        },
    };
}

function timers() {
    const armed: Array<{ callback: () => void; delayMs: number }> = [];
    return {
        armed,
        clearTimer: () => {},
        setTimer: (callback: () => void, delayMs: number) => {
            armed.push({ callback, delayMs });
            return { unref: () => {} } as unknown as NodeJS.Timeout;
        },
    };
}

describe('background refresh on a loaded machine', () => {
    it('skips a resident poll round and retries it on the floor delay', async () => {
        const clock = timers();
        const load = loadGate(true);
        const refresh = vi.fn(() => Promise.resolve());
        const poll = new ResidentPoll({
            clock: { ...clock, now: () => 0 },
            expiresAt: () => 0,
            load,
            logger: await logger(),
            refresh,
        });
        poll.set(new Set(['session-1']));
        clock.armed.at(-1)!.callback();

        await vi.waitFor(() => expect(clock.armed).toHaveLength(2));
        expect(refresh).not.toHaveBeenCalled();
        expect(load.deferred).toEqual(['project-status-poll']);
        expect(clock.armed.at(-1)!.delayMs).toBe(15_000);
        poll.dispose();
    });

    it('skips a delivery watch round and retries it on the pending delay', async () => {
        const clock = timers();
        const load = loadGate(true);
        const watchSession = vi.fn(() => Promise.resolve('refreshed' as const));
        const watch = new DeliveryWatch({
            ...clock,
            isEnabled: () => true,
            listSessions: () => ['session-1'],
            load,
            logger: await logger(),
            polledSessionIds: () => new Set(),
            summaryOf: () => {},
            watchSession,
        });
        watch.start();
        clock.armed.at(-1)!.callback();

        await vi.waitFor(() => expect(clock.armed).toHaveLength(2));
        expect(watchSession).not.toHaveBeenCalled();
        expect(load.deferred).toEqual(['delivery-watch']);
        expect(clock.armed.at(-1)!.delayMs).toBe(60_000);
        watch.dispose();
    });
});
