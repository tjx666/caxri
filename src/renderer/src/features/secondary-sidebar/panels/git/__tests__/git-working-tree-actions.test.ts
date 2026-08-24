import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve({})),
    invalidateQueries: vi.fn(),
    pushToast: vi.fn(),
    tryCommand: vi.fn(async (...[, run]: [string, () => Promise<unknown>]): Promise<unknown> => {
        try {
            return await run();
        } catch {
            return undefined;
        }
    }),
}));

vi.mock('../../../../../lib/caxri', () => ({ caxri: { request: mocks.caxriRequest } }));
vi.mock('../../../../../queries/client', () => ({
    queryClient: { invalidateQueries: mocks.invalidateQueries },
}));
vi.mock('../../../../../stores/toasts', () => ({
    pushToast: mocks.pushToast,
    tryCommand: mocks.tryCommand,
}));

import {
    describeSyncOutcome,
    discardAllChanges,
    discardFileChanges,
    syncRepo,
} from '../git-working-tree-actions';

const SESSION_ID = 'session-1';
const REPO = { id: 'repo-1', name: 'caxri', changedFileCount: 2, ahead: 0, behind: 0 };

describe('describeSyncOutcome', () => {
    it('reports up to date when nothing was ahead or behind', () => {
        expect(describeSyncOutcome(0, 0)).toBe('Already up to date');
    });

    it('reports a sync happened when local commits were ahead', () => {
        expect(describeSyncOutcome(2, 0)).toBe('Synced with remote');
    });

    it('reports a sync happened when the remote was ahead', () => {
        expect(describeSyncOutcome(0, 3)).toBe('Synced with remote');
    });
});

describe('syncRepo', () => {
    it('sends a git.sync request and invalidates working-tree queries on success', async () => {
        mocks.caxriRequest.mockClear();
        mocks.invalidateQueries.mockClear();
        mocks.pushToast.mockClear();

        await syncRepo(SESSION_ID, REPO);

        expect(mocks.caxriRequest).toHaveBeenCalledWith('git.sync', {
            sessionId: SESSION_ID,
            repositoryId: REPO.id,
        });
        expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
    });

    it('toasts "Already up to date" when nothing was ahead or behind before the sync', async () => {
        mocks.caxriRequest.mockClear();
        mocks.pushToast.mockClear();

        await syncRepo(SESSION_ID, REPO);

        expect(mocks.pushToast).toHaveBeenCalledWith('success', 'Already up to date');
    });

    it('toasts "Synced with remote" when the repository was ahead or behind before the sync', async () => {
        mocks.caxriRequest.mockClear();
        mocks.pushToast.mockClear();

        await syncRepo(SESSION_ID, { ...REPO, ahead: 1, behind: 2 });

        expect(mocks.pushToast).toHaveBeenCalledWith('success', 'Synced with remote');
    });

    it('does not invalidate queries or toast success when the sync request fails', async () => {
        mocks.caxriRequest.mockClear();
        mocks.invalidateQueries.mockClear();
        mocks.pushToast.mockClear();
        mocks.caxriRequest.mockRejectedValueOnce(new Error('boom'));

        await syncRepo(SESSION_ID, REPO);

        expect(mocks.invalidateQueries).not.toHaveBeenCalled();
        expect(mocks.pushToast).not.toHaveBeenCalled();
    });
});

describe('discardAllChanges', () => {
    it('does nothing when the repository has no changed files', async () => {
        mocks.caxriRequest.mockClear();
        mocks.invalidateQueries.mockClear();

        await discardAllChanges(SESSION_ID, { ...REPO, changedFileCount: 0 });

        expect(mocks.caxriRequest).not.toHaveBeenCalled();
        expect(mocks.invalidateQueries).not.toHaveBeenCalled();
    });

    it('sends the all-files discard scope and invalidates queries when confirmed', async () => {
        mocks.caxriRequest.mockClear();
        mocks.invalidateQueries.mockClear();
        mocks.caxriRequest.mockResolvedValueOnce(null);

        await discardAllChanges(SESSION_ID, REPO);

        expect(mocks.caxriRequest).toHaveBeenCalledWith('git.discard', {
            sessionId: SESSION_ID,
            repositoryId: REPO.id,
            repositoryName: REPO.name,
            scope: { kind: 'all', fileCount: REPO.changedFileCount },
        });
        expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
    });

    it('does not invalidate queries when the confirmation dialog is canceled', async () => {
        mocks.caxriRequest.mockClear();
        mocks.invalidateQueries.mockClear();
        mocks.caxriRequest.mockResolvedValueOnce({ canceled: true });

        await discardAllChanges(SESSION_ID, REPO);

        expect(mocks.invalidateQueries).not.toHaveBeenCalled();
    });
});

describe('discardFileChanges', () => {
    it('marks an untracked file so the prompt warns about permanent deletion', async () => {
        mocks.caxriRequest.mockClear();
        mocks.invalidateQueries.mockClear();
        mocks.caxriRequest.mockResolvedValueOnce(null);

        await discardFileChanges(SESSION_ID, REPO, { path: 'new-file.ts', kind: 'untracked' });

        expect(mocks.caxriRequest).toHaveBeenCalledWith('git.discard', {
            sessionId: SESSION_ID,
            repositoryId: REPO.id,
            repositoryName: REPO.name,
            scope: { kind: 'file', path: 'new-file.ts', untracked: true },
        });
        expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
    });

    it('marks a tracked file as not untracked', async () => {
        mocks.caxriRequest.mockClear();
        mocks.invalidateQueries.mockClear();
        mocks.caxriRequest.mockResolvedValueOnce(null);

        await discardFileChanges(SESSION_ID, REPO, { path: 'src/index.ts', kind: 'modified' });

        expect(mocks.caxriRequest).toHaveBeenCalledWith('git.discard', {
            sessionId: SESSION_ID,
            repositoryId: REPO.id,
            repositoryName: REPO.name,
            scope: { kind: 'file', path: 'src/index.ts', untracked: false },
        });
        expect(mocks.invalidateQueries).toHaveBeenCalledTimes(1);
    });

    it('does not invalidate queries when the confirmation dialog is canceled', async () => {
        mocks.caxriRequest.mockClear();
        mocks.invalidateQueries.mockClear();
        mocks.caxriRequest.mockResolvedValueOnce({ canceled: true });

        await discardFileChanges(SESSION_ID, REPO, { path: 'src/index.ts', kind: 'modified' });

        expect(mocks.invalidateQueries).not.toHaveBeenCalled();
    });
});
