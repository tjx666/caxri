import type { CaxriMethod } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { queryClient } from '../../queries/client';
import { tryCommand } from '../../stores/toasts';

/**
 * Every cached read whose answer is branch-dependent. A checkout rewrites the working tree, so status, diffs, commit
 * history, blame, and the delivery rollup all describe the branch that was current when they resolved.
 */
const BRANCH_SWITCH_DEPENDENCIES = new Set<CaxriMethod>([
    'git.summary',
    'git.overview',
    'git.branches',
    'git.diffDocument',
    'git.pullRequestChanges',
    'git.pullRequestDiffDocument',
    'git.commits',
    'git.commitDetails',
    'git.blame',
    'git.fileHead',
    'projectStatus.overview',
    'projectStatus.summary',
]);

/**
 * Checks out a branch and drops the Session's branch-dependent cache entries. A failed checkout leaves the cache alone:
 * the working tree never moved, so the entries still describe it.
 */
export async function switchBranch(
    sessionId: string,
    repoId: string,
    branch: string,
): Promise<void> {
    const result = await tryCommand(translate('statusBar.branch.switchFailed'), () =>
        caxri.request('git.switchBranch', { sessionId, repositoryId: repoId, branch }),
    );
    if (result === undefined) return;
    await queryClient.invalidateQueries({
        predicate: (query) => {
            const [method, parameters] = query.queryKey as [
                CaxriMethod,
                { sessionId?: string } | undefined,
            ];
            return BRANCH_SWITCH_DEPENDENCIES.has(method) && parameters?.sessionId === sessionId;
        },
    });
}
