import type { ContextMenuEntries } from '../../../lib/context-menu';
import { CONTEXT_MENU_SEPARATOR } from '../../../lib/context-menu';
import { pasteDisabledReason } from './file-operation-state';
import type { ResourceExplorerController } from './hooks/use-resource-explorer-controller';

/**
 * The native menu for the Files tree background, built when the menu opens. Row menus stop the gesture, so this only
 * opens for empty space and for rows without a menu of their own (symlinks).
 */
export function fileTreeRootMenu(
    controller: Pick<
        ResourceExplorerController,
        | 'createRootFile'
        | 'createRootFolder'
        | 'isRootPasteBlocked'
        | 'isRootPasteEmpty'
        | 'pasteIntoProjectRoot'
    >,
): ContextMenuEntries {
    const pasteReason = pasteDisabledReason({
        isBlocked: controller.isRootPasteBlocked,
        isClipboardEmpty: controller.isRootPasteEmpty,
    });
    return [
        { label: 'New File', onSelect: controller.createRootFile },
        { label: 'New Folder', onSelect: controller.createRootFolder },
        CONTEXT_MENU_SEPARATOR,
        {
            label: 'Paste',
            disabled: pasteReason !== undefined,
            disabledReason: pasteReason,
            shortcut: pasteReason === undefined ? 'cmd+v' : undefined,
            onSelect: controller.pasteIntoProjectRoot,
        },
    ];
}
