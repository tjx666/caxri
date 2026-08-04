import { describe, expect, it, vi } from 'vitest';

import { SessionRootGrants } from '../root-grants';

describe('SessionRootGrants', () => {
    it('consumes a directory grant only after successful Session creation', async () => {
        const grants = new SessionRootGrants();
        grants.grant('/project');

        await expect(grants.use('/project', () => Promise.resolve('created'))).resolves.toBe(
            'created',
        );
        await expect(grants.use('/project', () => Promise.resolve('duplicate'))).rejects.toThrow(
            'was not selected',
        );
    });

    it('restores a directory grant when Session creation fails', async () => {
        const grants = new SessionRootGrants();
        grants.grant('/project');
        const failure = vi.fn().mockRejectedValueOnce(new Error('Runtime unavailable'));

        await expect(grants.use('/project', failure)).rejects.toThrow('Runtime unavailable');
        await expect(grants.use('/project', () => Promise.resolve('retried'))).resolves.toBe(
            'retried',
        );
    });

    it('reserves a grant while creation is in flight', async () => {
        const grants = new SessionRootGrants();
        grants.grant('/project');
        const pending = Promise.withResolvers<string>();
        const first = grants.use('/project', () => pending.promise);

        await expect(grants.use('/project', () => Promise.resolve('duplicate'))).rejects.toThrow(
            'was not selected',
        );
        pending.resolve('created');
        await expect(first).resolves.toBe('created');
    });
});
