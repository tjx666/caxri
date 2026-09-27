import type { ReactElement } from 'react';

import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '../../../components/ui/context-menu';
import type { ResourceExplorerController } from './hooks/use-resource-explorer-controller';
import { rootPasteDisabledReason } from './hooks/use-resource-explorer-controller';

export function FileTreeRootContextMenu({
    children,
    controller,
}: {
    children: ReactElement;
    controller: ResourceExplorerController;
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
