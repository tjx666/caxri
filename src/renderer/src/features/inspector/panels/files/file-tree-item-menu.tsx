import type { FileEntry } from '@shared/types';

import {
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
} from '../../../../components/ui/context-menu';
import { copyFilePath, openFileInTerminal, rememberFile, revealFile } from './file-actions';
import { BUSY_DISABLED_REASON } from './file-tree-item-types';

export interface FileTreeItemMenuProperties {
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
 * Every menu item below fires an already-tracked file/terminal action whose own `tryCommand`
 * wrapper (or, for `confirmTrash`/`duplicateEntry`/`pasteIntoEntry`, an inner action that itself
 * funnels through `tryCommand`) reports failures via a toast, so these `onClick` handlers
 * intentionally discard the returned promise instead of awaiting it.
 */
function discard(promise: Promise<unknown>): void {
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void promise;
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
}: FileTreeItemMenuProperties) {
    return (
        <ContextMenuContent>
            <ContextMenuItem onClick={openEntry}>Open</ContextMenuItem>
            <ContextMenuItem onClick={() => discard(revealFile(sessionId, entry.path))}>
                Reveal in Finder
            </ContextMenuItem>
            <ContextMenuItem
                onClick={() =>
                    discard(
                        openFileInTerminal(
                            entry.kind === 'directory' ? entry.path : parentDirectory,
                        ),
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
                onClick={() => discard(pasteIntoEntry())}
            >
                Paste
            </ContextMenuItem>
            <ContextMenuItem
                disabled={duplicateBlocked}
                disabledReason={duplicateBlocked ? BUSY_DISABLED_REASON : undefined}
                onClick={() => discard(duplicateEntry())}
            >
                Duplicate
            </ContextMenuItem>
            <ContextMenuItem onClick={() => discard(copyFilePath(entry.path))}>
                Copy Path
            </ContextMenuItem>
            <ContextMenuItem onClick={() => discard(copyFilePath(entry.path, projectRoot))}>
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
            <ContextMenuItem hint="cmd+backspace" onClick={() => discard(confirmTrash())}>
                Move to Trash
            </ContextMenuItem>
        </ContextMenuContent>
    );
}
