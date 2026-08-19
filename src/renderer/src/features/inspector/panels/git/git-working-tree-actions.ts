import type { CaxriMethod } from '@shared/ipc';
import type { GitFileStatus, GitRepositorySummary } from '@shared/types';

import { caxri } from '../../../../lib/caxri';
import { queryClient } from '../../../../queries/client';
import { tryCommand } from '../../../../stores/toasts';

/**
 * Session-scoped Git reads a working-tree mutation can stale. The Runtime's `git.changed` event usually invalidates
 * most of these already, but a sync that only moves remote refs (or a discard raced against the watcher's coalescing
 * window) must not leave the panel showing pre-mutation state, so the mutation invalidates explicitly as well.
 */
const WORKING_TREE_MUTATION_DEPENDENCIES = new Set<CaxriMethod>([
    'git.summary',
    'git.overview',
    'git.diffDocument',
    'git.commits',
    'git.commitDetails',
    'git.blame',
    'git.fileHead',
]);

async function invalidateWorkingTreeQueries(sessionId: string): Promise<void> {
    await queryClient.invalidateQueries({
        predicate: (query) => {
            const [method, parameters] = query.queryKey as [
                CaxriMethod,
                { sessionId?: string } | undefined,
            ];
            return (
                WORKING_TREE_MUTATION_DEPENDENCIES.has(method) &&
                parameters?.sessionId === sessionId
            );
        },
    });
}

/**
 * VS Code-style Sync Changes: pull the upstream, then push local commits.
 */
export async function syncRepo(sessionId: string, repoId: string): Promise<void> {
    const result = await tryCommand('Sync failed', () =>
        caxri.request('git.sync', { sessionId, repositoryId: repoId }),
    );
    if (result === undefined) return;
    await invalidateWorkingTreeQueries(sessionId);
}

/**
 * Discards every working-tree change of the repository behind Main's native confirmation dialog.
 */
export async function discardAllChanges(
    sessionId: string,
    repo: Pick<GitRepositorySummary, 'id' | 'name' | 'changedFileCount'>,
): Promise<void> {
    if (repo.changedFileCount === 0) return;
    const result = await tryCommand('Discard failed', () =>
        caxri.request('git.discard', {
            sessionId,
            repositoryId: repo.id,
            repositoryName: repo.name,
            scope: { kind: 'all', fileCount: repo.changedFileCount },
        }),
    );
    if (result === undefined || result?.canceled) return;
    await invalidateWorkingTreeQueries(sessionId);
}

/**
 * Discards one file's working-tree change behind Main's native confirmation dialog. The prompt warns about permanent
 * deletion when the file is untracked.
 */
export async function discardFileChanges(
    sessionId: string,
    repo: Pick<GitRepositorySummary, 'id' | 'name'>,
    file: Pick<GitFileStatus, 'path' | 'kind'>,
): Promise<void> {
    const result = await tryCommand('Discard failed', () =>
        caxri.request('git.discard', {
            sessionId,
            repositoryId: repo.id,
            repositoryName: repo.name,
            scope: { kind: 'file', path: file.path, untracked: file.kind === 'untracked' },
        }),
    );
    if (result === undefined || result?.canceled) return;
    await invalidateWorkingTreeQueries(sessionId);
}
