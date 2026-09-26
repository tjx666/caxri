import { describe, expect, it, vi } from 'vitest';

import type { WatchHubSnapshot } from '../domains/watch-hub';
import { createWatchFailureProbe } from './support/watch-diagnostics';

function snapshot(native: number, polling: number, eventBatches: number): WatchHubSnapshot {
    return {
        registrations: native + polling,
        native,
        polling,
        gateTrips: 0,
        entries: native + polling === 0 ? [] : [{ label: 'config', native, polling, eventBatches }],
    };
}

describe('watch failure diagnostics', () => {
    it('preserves successful assertions without collecting another snapshot', async () => {
        const hub = { snapshot: vi.fn(() => snapshot(1, 0, 2)) };
        const diagnose = createWatchFailureProbe(hub, 'config', () => 0);
        await expect(diagnose(Promise.resolve('passed'))).resolves.toBe('passed');
        expect(hub.snapshot).toHaveBeenCalledTimes(1);
    });

    it.each([
        { native: 0, polling: 0, batches: 0, observed: 0, reason: 'no_registration' },
        { native: 0, polling: 1, batches: 2, observed: 0, reason: 'polling_without_outcome' },
        { native: 1, polling: 0, batches: 2, observed: 0, reason: 'no_batch_after_write' },
        { native: 1, polling: 0, batches: 3, observed: 0, reason: 'batch_without_observed_event' },
        {
            native: 1,
            polling: 0,
            batches: 3,
            observed: 1,
            reason: 'observed_event_without_asserted_state',
        },
    ])('classifies $reason using only allowlisted counters', async (testCase) => {
        const hub = {
            snapshot: vi
                .fn()
                .mockReturnValueOnce(snapshot(1, 0, 2))
                .mockReturnValueOnce({
                    ...snapshot(testCase.native, testCase.polling, testCase.batches),
                    privateValue: 'must-not-appear',
                }),
        };
        let observed = 0;
        const diagnose = createWatchFailureProbe(hub, 'config', () => observed);
        observed = testCase.observed;
        const cause = new Error('assertion failed');
        let failure: unknown;
        try {
            await diagnose(Promise.reject(cause));
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        const error = failure as Error;
        expect(error.cause).toBe(cause);
        expect(JSON.parse(error.message.replace('watcher_diagnostic ', ''))).toEqual({
            label: 'config',
            reason: testCase.reason,
            registrations: testCase.native + testCase.polling,
            native: testCase.native,
            polling: testCase.polling,
            gateTrips: 0,
            eventBatchesBefore: 2,
            eventBatchesAfter: testCase.batches,
            eventBatchesDelta: testCase.batches - 2,
            observedDelta: testCase.observed,
        });
        expect(error.message).not.toContain('must-not-appear');
    });
});
