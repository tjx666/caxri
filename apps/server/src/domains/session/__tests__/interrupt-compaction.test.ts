import type { SessionCompactionResult } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import type { SessionInterruptCompactionOptions } from '../interrupt-compaction';
import { SessionInterruptCompaction } from '../interrupt-compaction';

function createHarness(overrides: Partial<SessionInterruptCompactionOptions> = {}) {
    const running = new Set(['s1', 's2']);
    const interrupted: string[] = [];
    /**
     * Which Sessions were still running when the batch compaction started.
     */
    let runningAtCompaction: string[] | undefined;
    const write = vi.fn<StructuredLogger['write']>();
    const service = new SessionInterruptCompaction({
        listSessionIds: () => ['s1', 's2', 's3'],
        isTurnRunning: (sessionId) => running.has(sessionId),
        interrupt: (sessionId) => {
            interrupted.push(sessionId);
            // The turn settles a moment after its interrupt lands.
            setTimeout(() => running.delete(sessionId), 5);
            return Promise.resolve(true);
        },
        compact: () => {
            runningAtCompaction = [...running];
            return Promise.resolve<SessionCompactionResult>({
                items: [
                    { sessionId: 's1', outcome: 'submitted' },
                    { sessionId: 's2', outcome: 'submitted' },
                    { sessionId: 's3', outcome: 'already_compacted' },
                ],
                deferred: 0,
            });
        },
        isAirplaneModeActive: () => false,
        logger: { write } as unknown as StructuredLogger,
        pollMs: 1,
        ...overrides,
    });
    return {
        service,
        running,
        interrupted,
        /**
         * The fields of the one `session.interrupt_compaction` record.
         */
        loggedFields: () => {
            const [, event, entry] = write.mock.calls.at(-1) ?? [];
            expect(event).toBe('session.interrupt_compaction');
            return entry?.fields;
        },
        runningAtCompaction: () => runningAtCompaction,
    };
}

describe('SessionInterruptCompaction', () => {
    it('interrupts only running turns and compacts once they settled', async () => {
        const harness = createHarness();

        const result = await harness.service.run();

        expect(harness.interrupted).toEqual(['s1', 's2']);
        expect(harness.runningAtCompaction()).toEqual([]);
        expect(result).toMatchObject({ interrupted: 2, deferred: 0 });
        expect(harness.loggedFields()).toMatchObject({
            workingCount: 2,
            interruptedCount: 2,
            settled: true,
            submittedCount: 2,
        });
    });

    it('does not count a turn it could not interrupt safely', async () => {
        const harness = createHarness({
            interrupt: (sessionId) => Promise.resolve(sessionId === 's1'),
        });

        const result = await harness.service.run();

        expect(result.interrupted).toBe(1);
    });

    it('compacts anyway when an interrupted turn never settles', async () => {
        let now = 0;
        const harness = createHarness({
            interrupt: () => Promise.resolve(true),
            interruptWaitMs: 10,
            now: () => (now += 5),
        });

        const result = await harness.service.run();

        expect(harness.runningAtCompaction()).toEqual(['s1', 's2']);
        expect(result.interrupted).toBe(2);
        expect(harness.loggedFields()).toMatchObject({ settled: false });
    });

    it('refuses to run while Airplane Mode manages the Agents', async () => {
        const harness = createHarness({ isAirplaneModeActive: () => true });

        await expect(harness.service.run()).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(harness.interrupted).toEqual([]);
    });

    it('shares one run between overlapping requests', async () => {
        const harness = createHarness();

        const [first, second] = await Promise.all([harness.service.run(), harness.service.run()]);

        expect(first).toBe(second);
        expect(harness.interrupted).toEqual(['s1', 's2']);
    });
});
