import type { SourceControlAction, SourceControlViewModel } from '@caxri/protocol';

type ProviderModel = SourceControlViewModel['providers'][number];

/**
 * The Git extension's sync action id. The branch row's ahead/behind badge reuses that registered action instead of
 * dispatching a second sync path of its own.
 */
const SYNC_COMMAND_ID = 'caxri.git.sync';

/**
 * Names the trailing number of a group caption, which otherwise reads as a bare `2` after the `+3 -1` line counts.
 */
export function changedFileCountLabel(count: number): string {
    return `${count} changed file${count === 1 ? '' : 's'}`;
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
    provider: Pick<ProviderModel, 'actions' | 'descriptionBadge' | 'descriptionKind' | 'kindLabel'>,
): BranchRowInteraction {
    const canSwitchBranch = !provider.kindLabel;
    /**
     * Only the unsynced-commit counts (`↑2 ↓1`) mean sync; a `detached` badge does not.
     */
    const syncAction = /[↑↓]/.test(provider.descriptionBadge ?? '')
        ? provider.actions.find(
              (action) => action.command.id === SYNC_COMMAND_ID && !action.disabled,
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
