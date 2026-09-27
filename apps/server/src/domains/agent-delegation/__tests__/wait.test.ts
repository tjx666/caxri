import * as timers from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { pollDelegations } from '../wait';

vi.mock('node:timers/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof timers>();
    return { ...actual, setTimeout: vi.fn(actual.setTimeout) };
});

const neverSettles = () => new Promise<never>(() => {});

describe('pollDelegations', () => {
    afterEach(() => {
        vi.mocked(timers.setTimeout).mockClear();
    });

    it('fails a read that never settles once the wait deadline and its grace period pass', async () => {
        const actual = await vi.importActual<typeof timers>('node:timers/promises');
        // The first timer is the read's expiry; run it immediately instead of waiting out the real grace period.
        vi.mocked(timers.setTimeout).mockImplementationOnce((_delay, value, options) =>
            actual.setTimeout(0, value, options),
        );

        await expect(
            pollDelegations(['task'], neverSettles, () => false, 1000),
        ).rejects.toMatchObject({
            code: 'TIMEOUT',
        });
        const [expiryMs] = vi.mocked(timers.setTimeout).mock.calls[0];
        expect(expiryMs).toBeGreaterThan(5000);
        expect(expiryMs).toBeLessThanOrEqual(6000);
    });

    it('bounds a wait over many slow reads by one deadline instead of a grace period per read', async () => {
        const slowRead = async () => {
            await new Promise((resolve) => setTimeout(resolve, 60));
            return {
                receipt: {
                    delegationId: 'task',
                    projectId: 'project',
                    sessionId: 'session',
                    provider: 'codex' as const,
                    status: 'running' as const,
                    revision: 1,
                    createdAt: 1,
                    updatedAt: 1,
                },
            };
        };
        await expect(
            pollDelegations(['one', 'two', 'three'], slowRead, () => false, 1),
        ).resolves.toMatchObject({ outcome: 'timeout' });
        const expiries = vi.mocked(timers.setTimeout).mock.calls.map(([ms]) => ms!);
        expect(expiries).toHaveLength(3);
        // Each later read gets only what is left of the shared bound.
        expect(expiries[2]).toBeLessThan(expiries[0] - 50);
    });

    it('stops waiting on a read that never settles when the caller goes away', async () => {
        const controller = new AbortController();
        const waiting = pollDelegations(
            ['task'],
            neverSettles,
            () => false,
            60_000,
            controller.signal,
        );
        controller.abort();

        await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    });
});
