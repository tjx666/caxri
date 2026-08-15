import type { FileEntry } from '@shared/types';

import {
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
} from '../../../../components/ui/context-menu';
import { BUSY_DISABLED_REASON } from './file-tree-item-types';
import { copyFilePath, openFileInTerminal, rememberFile, revealFile } from './file-actions';

export interface FileTreeItemMenuProps {
    confirmTrash: () => Promise<void>;
    duplicateBlocked: boolean;
    duplicateEntry: () => Promise<void>;
    entry: FileEntry;
    openEntry: () => void;
    parentDirectory: string;
    pasteDisabled: boolean;
    pasteDisabledReason: string | undefined;
    pasteIntoEntry: () => Promise<void>;
    projectId: string;
    projectRoot: string;
    sessionId: string;
    startCreate: (itemKind: 'file' | 'directory') => void;
    startRename: () => void;
}

/**
 * The right-click menu for one file-tree row. Split out of `FileTreeItem` so that component stays
 * focused on the row's DOM/interaction wiring; every item here dispatches straight to the same
 * action functions and callbacks the row already computed, so behavior is unchanged.
 */
export function FileTreeItemMenu({
    confirmTrash,
    duplicateBlocked,
    duplicateEntry,
    entry,
    openEntry,
    parentDirectory,
    pasteDisabled,
    pasteDisabledReason,
    pasteIntoEntry,
    projectId,
    projectRoot,
    sessionId,
    startCreate,
    startRename,
}: FileTreeItemMenuProps) {
    return (
        <ContextMenuContent>
            <ContextMenuItem onClick={openEntry}>Open</ContextMenuItem>
            <ContextMenuItem onClick={() => void revealFile(sessionId, entry.path)}>
                Reveal in Finder
            </ContextMenuItem>
            <ContextMenuItem
                onClick={() =>
                    void openFileInTerminal(
                        entry.kind === 'directory' ? entry.path : parentDirectory,
                    )
                }
            >
                Open in Terminal
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
                hint="cmd+x"
                onClick={() => rememberFile(projectId, entry.path, 'cut')}
            >
                Cut
            </ContextMenuItem>
            <ContextMenuItem
                hint="cmd+c"
                onClick={() => rememberFile(projectId, entry.path, 'copy')}
            >
                Copy
            </ContextMenuItem>
            {/* Always shown so Paste's availability (and why it's unavailable) is discoverable
                from the mouse menu instead of only surfacing through a Cmd+V error toast. */}
            <ContextMenuItem
                disabled={pasteDisabled}
                disabledReason={pasteDisabledReason}
                hint={pasteDisabled ? undefined : 'cmd+v'}
                onClick={() => void pasteIntoEntry()}
            >
                Paste
            </ContextMenuItem>
            <ContextMenuItem
                disabled={duplicateBlocked}
                disabledReason={duplicateBlocked ? BUSY_DISABLED_REASON : undefined}
                onClick={() => void duplicateEntry()}
            >
                Duplicate
            </ContextMenuItem>
            <ContextMenuItem onClick={() => void copyFilePath(entry.path)}>
                Copy Path
            </ContextMenuItem>
            <ContextMenuItem onClick={() => void copyFilePath(entry.path, projectRoot)}>
                Copy Relative Path
            </ContextMenuItem>
            <ContextMenuSeparator />
            {entry.kind === 'directory' && (
                <>
                    <ContextMenuItem onClick={() => startCreate('file')}>New File</ContextMenuItem>
                    <ContextMenuItem onClick={() => startCreate('directory')}>
                        New Folder
                    </ContextMenuItem>
                </>
            )}
            <ContextMenuItem hint="enter" onClick={startRename}>
                Rename
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem hint="cmd+backspace" onClick={() => void confirmTrash()}>
                Move to Trash
            </ContextMenuItem>
        </ContextMenuContent>
    );
}
