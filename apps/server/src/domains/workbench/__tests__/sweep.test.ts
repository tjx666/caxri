import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import type { CaxriDatabase } from '../../db';
import { sweepWorkbenchRoots } from '../sweep';

const binding = (projectId: string) => ({
    projectId,
    workbenchRootProjectId: `${projectId}-worktree`,
});

function setup(isClosed: () => boolean) {
    const entries = [
        { sessionId: 's1', binding: binding('owner-a') },
        { sessionId: 's2', binding: binding('owner-a') },
        { sessionId: 's3', binding: binding('owner-b') },
    ];
    const listSessions = vi.fn();
    const getSessionWorkbenchBinding = vi.fn();
    const database = {
        getProject: (id: string) => ({ id, rootPath: `/root/${id}` }),
        getSessionWorkbenchBinding,
        listActiveWorktreeBindings: () => entries,
        listSessions,
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
    return { getSessionWorkbenchBinding, listSessions, loadTopology, run, validateBinding };
}

describe('sweepWorkbenchRoots', () => {
    it('reads one topology per owner and validates every bound Session', async () => {
        const { loadTopology, run, validateBinding } = setup(() => false);
        await run();
        expect(loadTopology.mock.calls).toEqual([['/root/owner-a'], ['/root/owner-b']]);
        expect(validateBinding).toHaveBeenCalledTimes(3);
    });

    it('never walks every Session or reads bindings row by row', async () => {
        const { getSessionWorkbenchBinding, listSessions, run } = setup(() => false);
        await run();
        expect(listSessions).not.toHaveBeenCalled();
        expect(getSessionWorkbenchBinding).not.toHaveBeenCalled();
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
