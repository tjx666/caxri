import type { CaxriMethod } from '@shared/ipc';
import type { GitFileStatus, GitRepositorySummary } from '@shared/types';

import { queryClient } from '../../../queries/client';
import { pushToast, tryCommand } from '../../../stores/toasts';
import type { SourceControlClient } from '../view-operation-client';

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

const CONTROLLED_GIT_READ_OPERATIONS = new Set([
    'git.summary',
    'git.pullRequestChanges',
    'git.commits',
    'git.commitDetails',
    'git.remoteHost',
]);

async function invalidateWorkingTreeQueries(
    client: SourceControlClient,
    sessionId: string,
): Promise<void> {
    await queryClient.invalidateQueries({
        predicate: (query) => {
            const [method, parameters] = query.queryKey as [
                CaxriMethod,
                { sessionId?: string; operation?: string; viewId?: string } | undefined,
            ];
            return (
                (WORKING_TREE_MUTATION_DEPENDENCIES.has(method) &&
                    parameters?.sessionId === sessionId) ||
                (method === 'viewContainers.viewOperation' &&
                    parameters?.viewId === client.viewId &&
                    typeof parameters.operation === 'string' &&
                    CONTROLLED_GIT_READ_OPERATIONS.has(parameters.operation))
            );
        },
    });
}

/**
 * Sync's only visible feedback used to be a failure toast — a clean sync (or a "nothing to do" no-op) left the user
 * guessing whether the click did anything. `ahead`/`behind` from _before_ the sync already answers that: if both were
 * zero there was nothing to pull or push, otherwise the sync moved at least one ref.
 */
export function describeSyncOutcome(ahead: number, behind: number): string {
    return ahead === 0 && behind === 0 ? 'Already up to date' : 'Synced with remote';
}

/**
 * VS Code-style Sync Changes: pull the upstream, then push local commits.
 */
export async function syncRepo(
    client: SourceControlClient,
    sessionId: string,
    repo: Pick<GitRepositorySummary, 'ahead' | 'behind' | 'id'>,
): Promise<void> {
    const result = await tryCommand('Sync failed', () => client.sync(repo.id));
    if (result === undefined) return;
    pushToast('success', describeSyncOutcome(repo.ahead, repo.behind));
    await invalidateWorkingTreeQueries(client, sessionId);
}

/**
 * Discards every working-tree change of the repository behind Main's native confirmation dialog.
 */
export async function discardAllChanges(
    client: SourceControlClient,
    sessionId: string,
    repo: Pick<GitRepositorySummary, 'id' | 'name' | 'changedFileCount'>,
): Promise<void> {
    if (repo.changedFileCount === 0) return;
    const result = await tryCommand('Discard failed', () =>
        client.discard(
            { id: repo.id, name: repo.name },
            { kind: 'all', fileCount: repo.changedFileCount },
        ),
    );
    if (result === undefined || result?.canceled) return;
    await invalidateWorkingTreeQueries(client, sessionId);
}

/**
 * Discards one file's working-tree change behind Main's native confirmation dialog. The prompt warns about permanent
 * deletion when the file is untracked.
 */
export async function discardFileChanges(
    client: SourceControlClient,
    sessionId: string,
    repo: Pick<GitRepositorySummary, 'id' | 'name'>,
    file: Pick<GitFileStatus, 'path' | 'kind'>,
): Promise<void> {
    const result = await tryCommand('Discard failed', () =>
        client.discard(
            { id: repo.id, name: repo.name },
            { kind: 'file', path: file.path, untracked: file.kind === 'untracked' },
        ),
    );
    if (result === undefined || result?.canceled) return;
    await invalidateWorkingTreeQueries(client, sessionId);
}
