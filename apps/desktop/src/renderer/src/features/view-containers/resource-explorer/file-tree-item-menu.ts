import type { FileEntry } from '@caxri/protocol';
import { projectRelativePath } from '@caxri/protocol';

import { translate } from '../../../i18n';
import type { ContextMenuEntries } from '../../../lib/context-menu';
import { CONTEXT_MENU_SEPARATOR } from '../../../lib/context-menu';
import { copyFileName, copyFilePath } from '../../../lib/copy-file-path';
import {
    openFileInTerminal,
    openFileWithDefaultApp,
    revealFile,
} from '../../../lib/desktop-file-actions';
import { useDialogStore } from '../../../stores/dialogs';
import { isLocalOnlyAvailable } from '../../../stores/environment';
import { openFilePreview } from '../../preview/preview-commands';
import { canPreviewPath } from '../../preview/preview-registry';
import { projectSearchFolderInclude } from '../../project-search/project-search-seed';
import { fileOperationBusyReason } from './file-operation-state';
import { rememberFile } from './file-paste-actions';

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
 * through `tryCommand`, so the menu does not handle their results. An SSH Host window drops the entries that hand the
 * file to this Mac (default app, Finder), since the file lives on the SSH Host; Trash stays, because Main moves the
 * entry into the SSH Host's own Trash.
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
    projectRoot,
    startCreate,
    startRename,
}: FileTreeItemMenuOptions): ContextMenuEntries {
    const isFile = entry.kind === 'file';
    const isDirectory = entry.kind === 'directory';
    const isLocal = isLocalOnlyAvailable();
    return [
        { label: translate('common.open'), onSelect: openEntry },
        isFile &&
            canPreviewPath(entry.path) && {
                label: translate('viewContainers.files.menu.openPreview'),
                onSelect: () => openFilePreview(entry.path),
            },
        isFile &&
            isLocal && {
                label: translate('viewContainers.files.menu.openWithDefaultApp'),
                onSelect: () => openFileWithDefaultApp(entry.path),
            },
        isLocal && {
            label: translate('viewContainers.files.menu.revealInFinder'),
            onSelect: () => revealFile(entry.path),
        },
        {
            label: translate('viewContainers.files.menu.openInTerminal'),
            onSelect: () => openFileInTerminal(isDirectory ? entry.path : parentDirectory),
        },
        isDirectory && {
            label: translate('viewContainers.files.menu.findInFolder'),
            onSelect: () => findInFolder(entry.path, projectRoot),
        },
        CONTEXT_MENU_SEPARATOR,
        {
            label: translate('viewContainers.files.menu.cut'),
            shortcut: 'cmd+x',
            onSelect: () => rememberFile(entry.path, 'cut'),
        },
        {
            label: translate('common.copy'),
            shortcut: 'cmd+c',
            onSelect: () => rememberFile(entry.path, 'copy'),
        },
        /**
         * Always shown so Paste's availability, and why it is unavailable, is discoverable from the mouse menu instead
         * of only surfacing through a Cmd+V error toast.
         */
        {
            label: translate('viewContainers.files.menu.paste'),
            disabled: pasteDisabledReason !== undefined,
            disabledReason: pasteDisabledReason,
            shortcut: pasteDisabledReason === undefined ? 'cmd+v' : undefined,
            onSelect: pasteIntoEntry,
        },
        {
            label: translate('viewContainers.files.menu.duplicate'),
            disabled: duplicateBlocked,
            disabledReason: fileOperationBusyReason(translate),
            onSelect: duplicateEntry,
        },
        {
            label: translate('viewContainers.files.menu.copyPath'),
            onSelect: () => copyFilePath(entry.path),
        },
        {
            label: translate('viewContainers.files.menu.copyRelativePath'),
            onSelect: () => copyFilePath(entry.path, projectRoot),
        },
        {
            label: translate('viewContainers.files.menu.copyName'),
            onSelect: () => copyFileName(entry.path),
        },
        CONTEXT_MENU_SEPARATOR,
        isDirectory && {
            label: translate('viewContainers.files.newFile'),
            onSelect: () => startCreate('file'),
        },
        isDirectory && {
            label: translate('viewContainers.files.newFolder'),
            onSelect: () => startCreate('directory'),
        },
        { label: translate('common.rename'), shortcut: 'enter', onSelect: startRename },
        CONTEXT_MENU_SEPARATOR,
        {
            label: translate('viewContainers.files.menu.moveToTrash'),
            shortcut: 'cmd+backspace',
            onSelect: confirmTrash,
        },
    ];
}
