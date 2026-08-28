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
});
