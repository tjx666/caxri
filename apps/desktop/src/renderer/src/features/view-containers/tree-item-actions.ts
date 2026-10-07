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
