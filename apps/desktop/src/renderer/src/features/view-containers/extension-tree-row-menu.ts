import type { TreeItemDto } from '@caxri/protocol';

import type { ContextMenuEntries } from '../../lib/context-menu';
import { CONTEXT_MENU_SEPARATOR } from '../../lib/context-menu';
import type { TreeItemAction } from './tree-item-actions';

/**
 * Whether an extension tree row opens a menu on right-click, `Shift+F10`, or the Menu key: only when it has something
 * to run. A message row is excluded because the button inside it is its one control, and that button already answers to
 * the keyboard on its own.
 */
export function hasExtensionTreeRowMenu(item: TreeItemDto): boolean {
    return (
        item.variant !== 'message' && (item.command !== undefined || Boolean(item.actions?.length))
    );
}

/**
 * The row's context menu, built only from what the row already exposes, so it can never offer something the row could
 * not already do and never drifts from the inline buttons. The row's own command comes first, being what a click or
 * Enter runs; the inline actions follow in button order, each labeled with its command title. Choosing an entry runs
 * exactly what the matching click would: `activate` takes the row's activation path, and `runAction` the inline
 * button's, confirmation included. An action the row is already running shows as disabled, as its busy button does.
 *
 * Menu-only actions (VS Code's `contextValue` with `view/item/context`) would need an Extension API change and are out
 * of scope until a provider needs one.
 */
export function extensionTreeRowMenu(
    item: TreeItemDto,
    run: {
        activate: () => void;
        runAction: (action: TreeItemAction) => void;
        runningCommandIds: ReadonlySet<string>;
    },
): ContextMenuEntries {
    if (!hasExtensionTreeRowMenu(item)) return [];
    return [
        item.command && { label: item.command.title, onSelect: run.activate },
        CONTEXT_MENU_SEPARATOR,
        ...(item.actions ?? []).map((action) => ({
            disabled: run.runningCommandIds.has(action.command.id),
            label: action.command.title,
            onSelect: () => run.runAction(action),
        })),
    ];
}
