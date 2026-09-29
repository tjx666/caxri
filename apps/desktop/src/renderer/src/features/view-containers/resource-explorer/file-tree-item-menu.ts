import type { FileEntry } from '@caxri/protocol';

import type { ContextMenuEntries } from '../../../lib/context-menu';
import { CONTEXT_MENU_SEPARATOR } from '../../../lib/context-menu';
import { copyFilePath } from '../../../lib/copy-file-path';
import {
    openFileInTerminal,
    openFileWithDefaultApp,
    revealFile,
} from '../../../lib/desktop-file-actions';
import { projectRelativePath } from '../../../lib/file-path';
import { useDialogStore } from '../../../stores/dialogs';
import { openFilePreview } from '../../preview/preview-commands';
import { canPreviewPath } from '../../preview/preview-registry';
import { projectSearchFolderInclude } from '../../project-search/project-search-seed';
import { rememberFile } from './file-actions';
import { FILE_OPERATION_BUSY_REASON } from './file-operation-state';

export interface FileTreeItemMenuOptions {
    confirmTrash: () => Promise<void>;
    duplicateBlocked: boolean;
    duplicateEntry: () => Promise<void>;
    entry: FileEntry;
    openEntry: () => void;
    parentDirectory: string;
    /**
     * Why Paste cannot run here; the entry is enabled only while this is `undefined`.
     */
    pasteDisabledReason: string | undefined;
    pasteIntoEntry: () => Promise<void>;
    projectId: string;
    projectRoot: string;
    startCreate: (itemKind: 'file' | 'directory') => void;
    startRename: () => void;
}

/**
 * Opens Project search scoped to one directory, keeping the query the user last searched for, as VS Code's Explorer
 * does.
 */
function findInFolder(directory: string, projectRoot: string): void {
    const relativeDirectory = projectRelativePath(directory, projectRoot);
    if (relativeDirectory === undefined) return;
    useDialogStore
        .getState()
        .openProjectSearch({ include: projectSearchFolderInclude(relativeDirectory) });
}

/**
 * The native right-click menu for one file-tree row, built when the menu opens. Every entry dispatches straight to the
 * same action functions and callbacks the row already computed; the file and terminal actions report their own failures
 * through `tryCommand`, so the menu does not handle their results.
 */
export function fileTreeItemMenu({
    confirmTrash,
    duplicateBlocked,
    duplicateEntry,
    entry,
    openEntry,
    parentDirectory,
    pasteDisabledReason,
    pasteIntoEntry,
    projectId,
    projectRoot,
    startCreate,
    startRename,
}: FileTreeItemMenuOptions): ContextMenuEntries {
    const isFile = entry.kind === 'file';
    const isDirectory = entry.kind === 'directory';
    return [
        { label: 'Open', onSelect: openEntry },
        isFile &&
            canPreviewPath(entry.path) && {
                label: 'Open Preview',
                onSelect: () => openFilePreview(entry.path),
            },
        isFile && {
            label: 'Open with Default App',
            onSelect: () => openFileWithDefaultApp(entry.path),
        },
        { label: 'Reveal in Finder', onSelect: () => revealFile(entry.path) },
        {
            label: 'Open in Terminal',
            onSelect: () => openFileInTerminal(isDirectory ? entry.path : parentDirectory),
        },
        isDirectory && {
            label: 'Find in Folder…',
            onSelect: () => findInFolder(entry.path, projectRoot),
        },
        CONTEXT_MENU_SEPARATOR,
        {
            label: 'Cut',
            shortcut: 'cmd+x',
            onSelect: () => rememberFile(projectId, entry.path, 'cut'),
        },
        {
            label: 'Copy',
            shortcut: 'cmd+c',
            onSelect: () => rememberFile(projectId, entry.path, 'copy'),
        },
        /**
         * Always shown so Paste's availability, and why it is unavailable, is discoverable from the mouse menu instead
         * of only surfacing through a Cmd+V error toast.
         */
        {
            label: 'Paste',
            disabled: pasteDisabledReason !== undefined,
            disabledReason: pasteDisabledReason,
            shortcut: pasteDisabledReason === undefined ? 'cmd+v' : undefined,
            onSelect: pasteIntoEntry,
        },
        {
            label: 'Duplicate',
            disabled: duplicateBlocked,
            disabledReason: FILE_OPERATION_BUSY_REASON,
            onSelect: duplicateEntry,
        },
        { label: 'Copy Path', onSelect: () => copyFilePath(entry.path) },
        { label: 'Copy Relative Path', onSelect: () => copyFilePath(entry.path, projectRoot) },
        CONTEXT_MENU_SEPARATOR,
        isDirectory && { label: 'New File', onSelect: () => startCreate('file') },
        isDirectory && { label: 'New Folder', onSelect: () => startCreate('directory') },
        { label: 'Rename', shortcut: 'enter', onSelect: startRename },
        CONTEXT_MENU_SEPARATOR,
        { label: 'Move to Trash', shortcut: 'cmd+backspace', onSelect: confirmTrash },
    ];
}
