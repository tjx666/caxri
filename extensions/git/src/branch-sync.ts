import type { GitRepositorySummary, SourceControlAction } from 'caxri';

import type { RepoBranchRow } from './repo-row-labels';
import type { GitSourceControlMode, RegisterSourceControlAction } from './source-control-model';

export interface BranchSync {
    /**
     * The repository's Sync action, listed on its provider row; Working Tree mode only.
     */
    action?: SourceControlAction;
    /**
     * Published as the provider's `descriptionBadgeActionId`, so clicking the branch row's badge runs this same
     * registered action instead of the Renderer matching a Git command id.
     */
    badgeActionId?: string;
}

/**
 * Registers a repository's Sync action and names it as the branch row badge's action when that badge is the
 * unsynced-commit count (`↑2 ↓1`). A detached commit's `detached` badge is status only, and a branch level with its
 * upstream shows no badge at all.
 */
export function branchSync(
    mode: GitSourceControlMode,
    repo: Pick<GitRepositorySummary, 'ahead' | 'behind' | 'id' | 'name'>,
    branchRow: Pick<RepoBranchRow, 'badge' | 'kind'>,
    registerAction: RegisterSourceControlAction,
): BranchSync {
    if (mode !== 'working') return {};
    const action = registerAction({
        command: { id: 'caxri.git.sync', arguments: [repo.id, repo.ahead, repo.behind] },
        icon: { kind: 'theme', id: 'sync' },
        label: `Sync Changes in ${repo.name}`,
        progressLabel: `Syncing ${repo.name}`,
        errorMessage: 'Sync failed',
        tooltip: 'Sync Changes (Pull, then Push)',
    });
    return {
        action,
        ...(branchRow.badge && branchRow.kind === 'branch' && { badgeActionId: action.id }),
    };
}
