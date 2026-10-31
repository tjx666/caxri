import type { MethodResult, MobileTreeItemAction } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';

/**
 * The Workbench command a provider uses for "open this page", such as a draft pull request's `Open on GitHub`. The
 * phone opens it in the system browser rather than asking the computer to.
 */
const OPEN_EXTERNAL_COMMAND = 'caxri.openExternal';

/**
 * The glyph color of an inline action at rest, matching Desktop's `TreeItemAction.tone`: a ready `Merge` reads green, a
 * merge blocked by running checks amber, failing checks red. An action without a tone stays muted.
 */
export const treeActionTint = (
    tone: MobileTreeItemAction['tone'],
    theme: Pick<MobileTheme, 'danger' | 'muted' | 'success' | 'warning'>,
): string => {
    switch (tone) {
        case 'success':
            return theme.success;
        case 'warning':
            return theme.warning;
        case 'danger':
            return theme.danger;
        default:
            return theme.muted;
    }
};

export interface TreeActionDependencies {
    execute: (
        commandId: string,
        arguments_: unknown[],
    ) => Promise<MethodResult<'mobile.tree.executeCommand'>>;
    notify: (tone: 'error' | 'success', message: string, detail?: string) => void;
    openLink: (url: string) => Promise<void>;
    t: Translate;
}

/**
 * Runs an inline action's command the way Desktop's `runTreeItemCommand` does: `caxri.openExternal` opens its page
 * locally, and every other command runs in the Extension Host for this Session. The success toast prefers the command's
 * own result (`Squash-merged #42`, naming the method Server Core chose) over the provider's declared fallback; a
 * failure leads with the provider's prefix (`Couldn't merge #42`) and carries GitHub's reason as its second line.
 * Resolves once the command settled and never rejects, so the button can stay busy for exactly that long.
 */
export async function runTreeAction(
    action: Pick<MobileTreeItemAction, 'command' | 'feedback'>,
    { execute, notify, openLink, t }: TreeActionDependencies,
): Promise<void> {
    const { command, feedback } = action;
    const failure = feedback?.failure ?? t('panels.treeActionFailed', { title: command.title });
    if (command.id === OPEN_EXTERNAL_COMMAND) {
        const [url] = command.arguments ?? [];
        if (typeof url === 'string') await openLink(url);
        else notify('error', failure);
        return;
    }
    try {
        const result = await execute(command.id, [...(command.arguments ?? [])]);
        const message = result.message ?? feedback?.success;
        if (message) notify('success', message);
    } catch (error) {
        const reason = error instanceof Error ? error.message.trim() : '';
        notify('error', failure, reason || undefined);
    }
}
