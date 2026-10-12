import type { SourceControlAction, SourceControlViewModel } from '@caxri/protocol';

import type { ConfirmRequest } from '../../../stores/confirmations';

type ProviderModel = SourceControlViewModel['providers'][number];

/**
 * Names the trailing number of a group caption, which otherwise reads as a bare `2` after the `+3 -1` line counts.
 */
export function changedFileCountLabel(count: number): string {
    return `${count} changed file${count === 1 ? '' : 's'}`;
}

/**
 * The group caption's visible file count (`2 files`). A bare `2` beside the `+4 -1` line counts read as a third diff
 * figure, so the count names its unit on screen as well as in the accessible description.
 */
export function changedFileCountText(count: number): string {
    return `${count} ${count === 1 ? 'file' : 'files'}`;
}

/**
 * The caption's line-count tooltip. These lines are summed from the listed files, which include a new file's lines,
 * while the status bar's changes chip counts only the tracked diff; saying what is counted keeps the two from reading
 * as a disagreement.
 */
export const GROUP_LINE_STATS_NOTE = 'Lines changed in the listed files, including new files';

/**
 * Detail lines of the branch row's tooltip. The provider's hover text leads with the same branch name the tooltip
 * already shows as its title, so repeating it read as `main` over `main · tracking origin/main`.
 */
export function branchRowTooltipDetails(description: string, descriptionTooltip: string): string[] {
    if (descriptionTooltip === description) return [];
    const prefix = `${description} · `;
    return [
        descriptionTooltip.startsWith(prefix)
            ? descriptionTooltip.slice(prefix.length)
            : descriptionTooltip,
    ];
}

export interface BranchRowInteraction {
    /**
     * The branch picker targets the Session's primary repository, so only that repository's row opens it. Linked
     * repositories carry a `kindLabel`.
     */
    canSwitchBranch: boolean;
    /**
     * The repository's enabled sync action, run by clicking the ahead/behind badge; absent outside Working Tree mode.
     */
    syncAction?: SourceControlAction;
    /**
     * Gesture text for the row's tooltip hint and accessible description.
     */
    hints: string[];
}

export function branchRowInteraction(
    provider: Pick<
        ProviderModel,
        | 'actions'
        | 'descriptionBadge'
        | 'descriptionBadgeActionId'
        | 'descriptionKind'
        | 'kindLabel'
    >,
): BranchRowInteraction {
    const canSwitchBranch = !provider.kindLabel;
    /**
     * The provider names the action its badge runs, so the badge reuses that registered action instead of dispatching a
     * second sync path of its own. A status-only badge (`detached`) names none.
     */
    const syncAction =
        provider.descriptionBadge && provider.descriptionBadgeActionId
            ? provider.actions.find(
                  (action) => action.id === provider.descriptionBadgeActionId && !action.disabled,
              )
            : undefined;
    const switchVerb =
        provider.descriptionKind === 'commit' ? 'switch to a branch' : 'switch branches';
    return {
        canSwitchBranch,
        syncAction,
        hints: [
            canSwitchBranch && `Click or press Enter to ${switchVerb}`,
            syncAction && `Click ${provider.descriptionBadge} to sync changes`,
        ].filter((hint): hint is string => Boolean(hint)),
    };
}

function commitCount(count: number): string {
    return `${count} commit${count === 1 ? '' : 's'}`;
}

/**
 * The remote branch named by the provider's hover text (`main · tracking origin/main · 2 ahead, 1 behind`). The Source
 * Control model carries no separate upstream field, so this reads the same segment the tooltip already shows.
 */
export function trackedRemoteBranch(descriptionTooltip: string): string | undefined {
    return /(?:^| · )tracking (\S+)/.exec(descriptionTooltip)?.[1];
}

/**
 * The confirmation the branch row's `↑2 ↓1` badge asks before syncing. The badge reads as a status number, so a click
 * on it must not push or pull unannounced; the dialog names the remote branch and both counts. Counts come from the
 * sync action's own arguments (`[repositoryId, ahead, behind]`), the numbers the sync will act on.
 */
export function branchSyncConfirmRequest(
    provider: Pick<ProviderModel, 'descriptionTooltip'>,
    syncAction: Pick<SourceControlAction, 'command'>,
): ConfirmRequest {
    const [, ahead, behind] = syncAction.command.arguments ?? [];
    const remote = trackedRemoteBranch(provider.descriptionTooltip);
    const target = remote ?? 'its remote branch';
    const steps = [
        typeof behind === 'number' && behind > 0 && `pull ${commitCount(behind)} from ${target}`,
        typeof ahead === 'number' && ahead > 0 && `push ${commitCount(ahead)} to ${target}`,
    ].filter((step): step is string => Boolean(step));
    const summary = steps.length > 0 ? steps.join(', then ') : `sync with ${target}`;
    return {
        title: remote ? `Sync with ${remote}?` : 'Sync this branch?',
        message: `This will ${summary}.`,
        confirmLabel: 'Sync',
    };
}
