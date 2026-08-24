import type { ReactElement } from 'react';

import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '../../../../components/ui/context-menu';
import type { FileTreePanelController } from './use-file-tree-panel-controller';
import { rootPasteDisabledReason } from './use-file-tree-panel-controller';

export function FileTreeRootContextMenu({
    children,
    controller,
}: {
    children: ReactElement;
    controller: FileTreePanelController;
}) {
    return (
        <ContextMenu>
            <ContextMenuTrigger render={children} />
            <ContextMenuContent>
                <ContextMenuItem onClick={controller.createRootFile}>New File</ContextMenuItem>
                <ContextMenuItem onClick={controller.createRootFolder}>New Folder</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                    disabled={controller.isRootPasteDisabled}
                    disabledReason={rootPasteDisabledReason(controller)}
                    hint={controller.isRootPasteDisabled ? undefined : 'cmd+v'}
                    onClick={controller.pasteIntoProjectRoot}
                >
                    Paste
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}
