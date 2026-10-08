import type { TreeItemDto } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { dispatchExtensionViewAction } from './view-container-commands';

export type TreeItemAction = NonNullable<TreeItemDto['actions']>[number];

/**
 * Asks first when the provider attached a confirmation, then dispatches through the same path as the row's own command.
 * Resolves once the command settled, so the button can stay busy for the whole round trip rather than inviting a second
 * click while the first is still running.
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
    await dispatchExtensionViewAction(
        action.command.id,
        action.command.title,
        action.command.arguments ?? [],
    );
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
