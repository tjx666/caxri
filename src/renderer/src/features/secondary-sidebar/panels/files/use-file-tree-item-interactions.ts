import type { Dispatch, DragEvent, KeyboardEvent, RefObject, SetStateAction } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import type { FileEntry } from '@shared/types';

import { dragPath } from '../../../../lib/file-drag';
import { openFile } from '../../../editor/document-actions';
import { didTrashFile, duplicateFile, moveFile, pasteFile, rememberFile } from './file-actions';
import type { FileClipboardEntry } from './file-clipboard';
import { useFileClipboardStore } from './file-clipboard';
import type { PendingFileOperation } from './file-operation-state';
import { isPathBlockedByFileOperations } from './file-operation-state';
import type { EditRequest } from './file-tree-item-types';
import { BUSY_DISABLED_REASON } from './file-tree-item-types';
import {
    focusAdjacentTreeItem,
    focusParentTreeItem,
    focusTreeItemEdge,
} from './file-tree-navigation';
import { parentDirectoryPath } from './file-tree-refresh';

export interface UseFileTreeItemInteractionsOptions {
    clearFocusPath: () => void;
    depth: number;
    editing?: EditRequest;
    entry: FileEntry;
    expanded: boolean;
    focusPath?: string;
    index: number;
    operations: readonly PendingFileOperation[];
    projectId: string;
    selectedPath?: string;
    sessionId: string;
    setExpanded: (isNextExpanded: boolean | ((isCurrentExpanded: boolean) => boolean)) => void;
    setEditing: (editing?: EditRequest) => void;
    setSelectedPath: (path?: string) => void;
}

export interface UseFileTreeItemInteractionsResult {
    clipboard: FileClipboardEntry | undefined;
    confirmTrash: () => Promise<void>;
    dragBlocked: boolean;
    dropIntoDirectory: (event: DragEvent) => void;
    duplicateBlocked: boolean;
    duplicateEntry: () => Promise<void>;
    editable: boolean;
    expanded: boolean;
    handleKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
    isDropTarget: boolean;
    isRenaming: boolean;
    isRovingTabStop: boolean;
    openEntry: () => void;
    parentDirectory: string;
    pasteBlocked: boolean;
    pasteDisabled: boolean;
    pasteDisabledReason: string | undefined;
    pasteIntoEntry: () => Promise<void>;
    rowRef: RefObject<HTMLButtonElement | null>;
    setExpanded: (isNextExpanded: boolean | ((isCurrentExpanded: boolean) => boolean)) => void;
    setIsDropTarget: Dispatch<SetStateAction<boolean>>;
    startCreate: (itemKind: 'file' | 'directory') => void;
    startRename: () => void;
    symlinkReasonId: string;
}

/**
 * Owns every non-render concern for a single file-tree row: clipboard/drag-and-drop handlers, rename/create entry
 * points, roving-tabindex bookkeeping, and the keyboard shortcut map. Split out of `FileTreeItem` purely to keep that
 * component's JSX readable — every return here is consumed directly by the row's DOM attributes/handlers, so this hook
 * does not change any rendered output or handler semantics.
 */
export function useFileTreeItemInteractions({
    clearFocusPath,
    depth,
    editing,
    entry,
    expanded,
    focusPath,
    index,
    operations,
    projectId,
    selectedPath,
    sessionId,
    setExpanded,
    setEditing,
    setSelectedPath,
}: UseFileTreeItemInteractionsOptions): UseFileTreeItemInteractionsResult {
    const [isDropTarget, setIsDropTarget] = useState(false);
    const rowReference = useRef<HTMLButtonElement>(null);
    const symlinkReasonId = useId();
    const clipboard = useFileClipboardStore((state) => state.entry);
    const isRenaming = editing?.kind === 'rename' && editing.entry.path === entry.path;
    const isEditable = entry.kind !== 'symlink';
    const parentDirectory = parentDirectoryPath(entry.path);
    const pasteDirectory = entry.kind === 'directory' ? entry.path : parentDirectory;
    const isClipboardEmpty = !clipboard || clipboard.projectId !== projectId;
    const isPasteBlocked = isPathBlockedByFileOperations(operations, projectId, pasteDirectory);
    const isPasteDisabled = isClipboardEmpty || isPasteBlocked;
    const pasteDisabledReason = isClipboardEmpty
        ? 'Nothing to paste'
        : isPasteBlocked
          ? BUSY_DISABLED_REASON
          : undefined;
    const isDuplicateBlocked = isPathBlockedByFileOperations(
        operations,
        projectId,
        parentDirectory,
    );
    const isDragBlocked =
        isPathBlockedByFileOperations(operations, projectId, entry.path) ||
        isPathBlockedByFileOperations(operations, projectId, parentDirectory);
    /**
     * Roving tabindex: exactly one row in the whole tree is a Tab stop. The selected row owns it; with no selection,
     * the very first root-level row is the fallback so Tab always lands somewhere sensible instead of nowhere.
     */
    const isRovingTabStop = selectedPath ? selectedPath === entry.path : depth === 0 && index === 0;

    const startRename = (): void => {
        if (isEditable) setEditing({ kind: 'rename', entry });
    };
    const startCreate = (itemKind: 'file' | 'directory'): void => {
        if (entry.kind !== 'directory') return;
        setExpanded(true);
        setEditing({
            kind: 'create',
            directory: entry.path,
            itemKind,
            returnFocus: { kind: 'path', path: entry.path },
        });
    };
    const openEntry = (): void => {
        if (entry.kind === 'directory') setExpanded(true);
        // openFile funnels its own failures into a toast via tryCommand, nothing to await here.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        else void openFile(entry.path);
    };
    const pasteIntoEntry = async (): Promise<void> => {
        const currentClipboard = useFileClipboardStore.getState().entry;
        if (!currentClipboard) return;
        const pasted = await pasteFile(sessionId, projectId, pasteDirectory, currentClipboard);
        if (pasted) setSelectedPath(pasted.path);
    };
    const duplicateEntry = async (): Promise<void> => {
        const copied = await duplicateFile(sessionId, entry.path);
        if (copied) setSelectedPath(copied.path);
    };
    const confirmTrash = async (): Promise<void> => {
        if (!(await didTrashFile(sessionId, entry.path))) {
            return;
        }

        setSelectedPath(undefined);
        setEditing(undefined);
    };
    const dropIntoDirectory = async (event: DragEvent): Promise<void> => {
        event.preventDefault();
        event.stopPropagation();
        setIsDropTarget(false);
        if (isPasteBlocked) return;
        const source = dragPath(event);
        if (!source || entry.kind !== 'directory') return;
        const moved = await moveFile(sessionId, source, entry.path);
        if (moved) setSelectedPath(moved.path);
    };
    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            focusAdjacentTreeItem(event.currentTarget, 1);
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            focusAdjacentTreeItem(event.currentTarget, -1);
            return;
        }
        if (event.key === 'Home') {
            event.preventDefault();
            focusTreeItemEdge(event.currentTarget, 'first');
            return;
        }
        if (event.key === 'End') {
            event.preventDefault();
            focusTreeItemEdge(event.currentTarget, 'last');
            return;
        }
        if (event.key === 'ArrowRight') {
            if (entry.kind !== 'directory') return;
            event.preventDefault();
            // Collapsed -> expand in place; already expanded -> move focus into the first child,
            // matching the standard ARIA treeview keyboard pattern.
            if (!expanded) setExpanded(true);
            else focusAdjacentTreeItem(event.currentTarget, 1);
            return;
        }
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            if (expanded && entry.kind === 'directory') setExpanded(false);
            else focusParentTreeItem(event.currentTarget);
            return;
        }
        if (isEditable && event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            startRename();
            return;
        }
        if (!isEditable || !event.metaKey) return;
        const key = event.key.toLowerCase();
        if (!['backspace', 'c', 'v', 'x'].includes(key)) return;
        event.preventDefault();
        event.stopPropagation();
        switch (key) {
            case 'backspace': {
                // confirmTrash funnels its own failures into a toast via didTrashFile, nothing to
                // await here.
                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                void confirmTrash();
                break;
            }
            case 'c': {
                rememberFile(projectId, entry.path, 'copy');
                break;
            }
            case 'x': {
                rememberFile(projectId, entry.path, 'cut');
                break;
            }
            default: {
                // pasteIntoEntry funnels its own failures into a toast via pasteFile, nothing to
                // await here.
                if (!isPasteBlocked)
                    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                    void pasteIntoEntry();
            }
        }
    };

    useEffect(() => {
        if (isRenaming || focusPath !== entry.path) return;
        rowReference.current?.focus();
        clearFocusPath();
    }, [clearFocusPath, entry.path, focusPath, isRenaming]);

    return {
        clipboard,
        confirmTrash,
        dragBlocked: isDragBlocked,
        dropIntoDirectory,
        duplicateBlocked: isDuplicateBlocked,
        duplicateEntry,
        editable: isEditable,
        expanded,
        handleKeyDown,
        isDropTarget,
        isRenaming,
        isRovingTabStop,
        openEntry,
        parentDirectory,
        pasteBlocked: isPasteBlocked,
        pasteDisabled: isPasteDisabled,
        pasteDisabledReason,
        pasteIntoEntry,
        rowRef: rowReference,
        setExpanded,
        setIsDropTarget,
        startCreate,
        startRename,
        symlinkReasonId,
    };
}
