import type { SourceControlAction, SourceControlViewModel } from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import type { ConfirmRequest } from '../../../stores/confirmations';

type ProviderModel = SourceControlViewModel['providers'][number];

/**
 * Names the trailing number of a group caption, which otherwise reads as a bare `2` after the `+3 -1` line counts.
 */
export function changedFileCountLabel(count: number, t: Translate): string {
    return t(
        count === 1
            ? 'viewContainers.sourceControl.changedFilesOne'
            : 'viewContainers.sourceControl.changedFilesOther',
        { count },
    );
}

/**
 * The group caption's visible file count (`2 files`). A bare `2` beside the `+4 -1` line counts read as a third diff
 * figure, so the count names its unit on screen as well as in the accessible description.
 */
export function changedFileCountText(count: number, t: Translate): string {
    return t(
        count === 1
            ? 'viewContainers.sourceControl.filesOne'
            : 'viewContainers.sourceControl.filesOther',
        { count },
    );
}

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
    t: Translate,
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
    return {
        canSwitchBranch,
        syncAction,
        hints: [
            canSwitchBranch &&
                t(
                    provider.descriptionKind === 'commit'
                        ? 'viewContainers.sourceControl.branch.switchToBranchHint'
                        : 'viewContainers.sourceControl.branch.switchBranchesHint',
                ),
            syncAction &&
                t('viewContainers.sourceControl.branch.syncHint', {
                    badge: provider.descriptionBadge ?? '',
                }),
        ].filter((hint): hint is string => Boolean(hint)),
    };
}

function commitCount(count: number, t: Translate): string {
    return t(
        count === 1
            ? 'viewContainers.sourceControl.sync.commitsOne'
            : 'viewContainers.sourceControl.sync.commitsOther',
        { count },
    );
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
    t: Translate,
): ConfirmRequest {
    const [, ahead, behind] = syncAction.command.arguments ?? [];
    const remote = trackedRemoteBranch(provider.descriptionTooltip);
    const target = remote ?? t('viewContainers.sourceControl.sync.remoteFallback');
    const steps = [
        typeof behind === 'number' &&
            behind > 0 &&
            t('viewContainers.sourceControl.sync.pull', {
                commits: commitCount(behind, t),
                target,
            }),
        typeof ahead === 'number' &&
            ahead > 0 &&
            t('viewContainers.sourceControl.sync.push', { commits: commitCount(ahead, t), target }),
    ].filter((step): step is string => Boolean(step));
    const summary =
        steps.length > 0
            ? steps.join(t('viewContainers.sourceControl.sync.stepSeparator'))
            : t('viewContainers.sourceControl.sync.fallbackSummary', { target });
    return {
        title: remote
            ? t('viewContainers.sourceControl.sync.titleRemote', { remote })
            : t('viewContainers.sourceControl.sync.title'),
        message: t('viewContainers.sourceControl.sync.message', { summary }),
        confirmLabel: t('viewContainers.sourceControl.sync.confirm'),
    };
}
