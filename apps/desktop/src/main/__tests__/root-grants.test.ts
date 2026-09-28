import { describe, expect, it, vi } from 'vitest';

import { ProjectRootGrants } from '../root-grants';

describe('ProjectRootGrants', () => {
    it('consumes a folder grant only after successful Project creation', async () => {
        const grants = new ProjectRootGrants();
        grants.grant('/project');

        await expect(grants.use('/project', () => Promise.resolve('created'))).resolves.toBe(
            'created',
        );
        await expect(grants.use('/project', () => Promise.resolve('duplicate'))).rejects.toThrow(
            'was not selected',
        );
    });

    it('restores a folder grant when Project creation fails', async () => {
        const grants = new ProjectRootGrants();
        grants.grant('/project');
        const failure = vi.fn().mockRejectedValueOnce(new Error('Runtime unavailable'));

        await expect(grants.use('/project', failure)).rejects.toThrow('Runtime unavailable');
        await expect(grants.use('/project', () => Promise.resolve('retried'))).resolves.toBe(
            'retried',
        );
    });

    it('reserves a grant while creation is in flight', async () => {
        const grants = new ProjectRootGrants();
        grants.grant('/project');
        const pending = Promise.withResolvers<string>();
        const first = grants.use('/project', () => pending.promise);

        await expect(grants.use('/project', () => Promise.resolve('duplicate'))).rejects.toThrow(
            'was not selected',
        );
        pending.resolve('created');
        await expect(first).resolves.toBe('created');
    });

    it('revokes a folder grant when Project creation is canceled', async () => {
        const grants = new ProjectRootGrants();
        grants.grant('/project');
        grants.revoke('/project');

        await expect(grants.use('/project', () => Promise.resolve('created'))).rejects.toThrow(
            'was not selected',
        );
    });

    it('expires an unused folder grant', async () => {
        vi.useFakeTimers();
        const grants = new ProjectRootGrants(1_000);
        grants.grant('/project');
        await vi.advanceTimersByTimeAsync(1_001);

        await expect(grants.use('/project', () => Promise.resolve('created'))).rejects.toThrow(
            'expired',
        );
        vi.useRealTimers();
    });

    it('restores the original deadline (not a fresh one) on failure, so it stays expired past that deadline', async () => {
        vi.useFakeTimers();
        try {
            const grants = new ProjectRootGrants(60_000);
            grants.grant('/project');

            // `use()` starts well inside the 60s window (at 59s) but `create()` does not settle
            // until 61s, past the original deadline.
            await vi.advanceTimersByTimeAsync(59_000);
            const pending = Promise.withResolvers<string>();
            const attempt = grants.use('/project', () => pending.promise);
            await vi.advanceTimersByTimeAsync(2_000);
            pending.reject(new Error('Runtime unavailable'));
            await expect(attempt).rejects.toThrow('Runtime unavailable');

            // A naive `grant()`-on-failure retry would mint a fresh 60s window from t=61s and
            // still accept this retry; restoring the original t=60s deadline must reject it.
            await expect(grants.use('/project', () => Promise.resolve('retried'))).rejects.toThrow(
                'expired',
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves a restored grant usable up to its original deadline after a failure well before expiry', async () => {
        vi.useFakeTimers();
        try {
            const grants = new ProjectRootGrants(60_000);
            grants.grant('/project');

            await vi.advanceTimersByTimeAsync(10_000);
            await expect(
                grants.use('/project', () => Promise.reject(new Error('Runtime unavailable'))),
            ).rejects.toThrow('Runtime unavailable');

            // Still short of the original 60s deadline: the restored grant must still work.
            await vi.advanceTimersByTimeAsync(45_000);
            await expect(grants.use('/project', () => Promise.resolve('retried'))).resolves.toBe(
                'retried',
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not resurrect a grant that was revoked while creation was in flight', async () => {
        const grants = new ProjectRootGrants();
        grants.grant('/project');
        const pending = Promise.withResolvers<string>();
        const attempt = grants.use('/project', () => pending.promise);

        grants.revoke('/project');
        pending.reject(new Error('Runtime unavailable'));
        await expect(attempt).rejects.toThrow('Runtime unavailable');

        await expect(grants.use('/project', () => Promise.resolve('created'))).rejects.toThrow(
            'was not selected',
        );
    });

    it('does not clobber a fresh grant issued while a previous creation was failing in flight', async () => {
        vi.useFakeTimers();
        try {
            const grants = new ProjectRootGrants(60_000);
            grants.grant('/project');
            const pending = Promise.withResolvers<string>();
            const firstAttempt = grants.use('/project', () => pending.promise);

            // The user re-selects the same root while the first attempt is still in flight,
            // minting a brand new 60s grant from now.
            await vi.advanceTimersByTimeAsync(30_000);
            grants.grant('/project');

            pending.reject(new Error('Runtime unavailable'));
            await expect(firstAttempt).rejects.toThrow('Runtime unavailable');

            // The fresh grant (expires at t=90s) must still be usable, unclobbered by the first
            // attempt's stale restore (which would have been the original t=60s deadline).
            await vi.advanceTimersByTimeAsync(59_000);
            await expect(grants.use('/project', () => Promise.resolve('retried'))).resolves.toBe(
                'retried',
            );
        } finally {
            vi.useRealTimers();
        }
    });
});
