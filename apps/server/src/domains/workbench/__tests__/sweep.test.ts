import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import type { CaxriDatabase } from '../../db';
import { sweepWorkbenchRoots } from '../sweep';

const binding = (projectId: string) => ({
    projectId,
    workbenchProjectId: `${projectId}-worktree`,
});

function setup(isClosed: () => boolean) {
    const sessions = ['s1', 's2', 's3'].map((id) => ({ id }));
    const bindings = new Map([
        ['s1', binding('owner-a')],
        ['s2', binding('owner-a')],
        ['s3', binding('owner-b')],
    ]);
    const database = {
        getProject: (id: string) => ({ id, rootPath: `/root/${id}` }),
        getSessionWorkbenchBinding: (id: string) => bindings.get(id),
        listSessions: () => sessions,
    } as unknown as CaxriDatabase;
    const loadTopology = vi.fn(() => Promise.resolve({ repositoryKey: 'key', worktrees: [] }));
    const validateBinding = vi.fn(() => Promise.resolve(false));
    const run = () =>
        sweepWorkbenchRoots({
            database,
            isClosed,
            loadTopology,
            logger: { write: vi.fn() } as unknown as StructuredLogger,
            validateBinding,
        });
    return { loadTopology, run, validateBinding };
}

describe('sweepWorkbenchRoots', () => {
    it('reads one topology per owner and validates every bound Session', async () => {
        const { loadTopology, run, validateBinding } = setup(() => false);
        await run();
        expect(loadTopology.mock.calls).toEqual([['/root/owner-a'], ['/root/owner-b']]);
        expect(validateBinding).toHaveBeenCalledTimes(3);
    });

    it('stops at the next boundary once the service closes', async () => {
        let isClosed = false;
        const { loadTopology, run, validateBinding } = setup(() => isClosed);
        validateBinding.mockImplementation(() => {
            isClosed = true;
            return Promise.resolve(false);
        });
        await run();
        expect(validateBinding).toHaveBeenCalledTimes(1);
        expect(loadTopology).toHaveBeenCalledTimes(1);
    });
});
