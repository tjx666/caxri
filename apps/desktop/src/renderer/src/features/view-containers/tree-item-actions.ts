import type { TreeItemDto } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { openExternalUrl } from '../../lib/external-link';
import { pushToast } from '../../stores/toasts';
import { dispatchExtensionViewAction } from './view-container-commands';

/**
 * The Workbench command a provider uses for "open this page", resolved here rather than in the Extension Host.
 */
const OPEN_EXTERNAL_COMMAND = 'caxri.openExternal';

export type TreeItemAction = NonNullable<TreeItemDto['actions']>[number];

/**
 * Asks first when the provider attached a confirmation, then runs the action's command through
 * {@link runTreeItemCommand}. Resolves once the command settled, so the button can stay busy for the whole round trip
 * rather than inviting a second click while the first is still running.
 */
export async function runTreeItemAction(action: TreeItemAction): Promise<void> {
    if (action.confirmation) {
        const isConfirmed = await caxri.window.showConfirm({
            title: action.confirmation.title,
            message: action.confirmation.message,
            confirmLabel: action.confirmation.confirmLabel,
        });
        if (!isConfirmed) return;
    }
    await runTreeItemCommand(action.command, action.feedback);
}

/**
 * The one way a tree row's own command or an inline action's command runs: `caxri.openExternal` (a link row, or a
 * blocked merge's "Open on GitHub") opens the page in the Renderer without a round trip to the extension, and every
 * other command goes through the shared extension dispatcher with its toasts.
 */
export async function runTreeItemCommand(
    command: TreeItemAction['command'],
    feedback?: TreeItemAction['feedback'],
): Promise<void> {
    if (command.id === OPEN_EXTERNAL_COMMAND) {
        const [url] = command.arguments ?? [];
        if (typeof url === 'string')
            await openExternalUrl(url, (message) => pushToast('error', message));
        else pushToast('error', `Unable to run ${command.title}. The link is missing.`);
        return;
    }
    await dispatchExtensionViewAction(command.id, command.title, command.arguments ?? [], feedback);
}

/**
 * What a key pressed on an inline action button does, given the button's position among the row's actions:
 *
 * - `focus`: move roving focus to the action at `index`;
 * - `row`: hand focus back to the row (Left from the first action, or Escape);
 * - `native`: the button handles the key itself (Enter and Space click it), so the row must not see it;
 * - `none`: the key belongs to the group but has nothing to do (Right on the last action);
 * - `undefined`: the key is not the action group's, and it may bubble to the row (Up/Down keep moving between rows).
 *
 * Left and Right stop at the ends instead of wrapping, matching the tree's own edge behavior.
 */
export type TreeItemActionKeyIntent =
    { kind: 'focus'; index: number } | { kind: 'native' } | { kind: 'none' } | { kind: 'row' };

export function treeItemActionKeyIntent(
    key: string,
    index: number,
    count: number,
): TreeItemActionKeyIntent | undefined {
    switch (key) {
        case 'ArrowLeft':
            return index <= 0 ? { kind: 'row' } : { kind: 'focus', index: index - 1 };
        case 'ArrowRight':
            return index >= count - 1 ? { kind: 'none' } : { kind: 'focus', index: index + 1 };
        case 'Escape':
            return { kind: 'row' };
        case 'Enter':
        case ' ':
            return { kind: 'native' };
        default:
            return undefined;
    }
}
