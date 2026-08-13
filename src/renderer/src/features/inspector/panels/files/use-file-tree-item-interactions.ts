import {
    useEffect,
    useId,
    useRef,
    useState,
    type DragEvent,
    type Dispatch,
    type KeyboardEvent,
    type RefObject,
    type SetStateAction,
} from 'react';

import type { FileEntry } from '@shared/types';

import { openFile } from '../../../editor/document-actions';
import { duplicateFile, moveFile, pasteFile, rememberFile, trashFile } from './file-actions';
import type { FileClipboardEntry } from './file-clipboard';
import { useFileClipboardStore } from './file-clipboard';
import { dragPath } from './file-tree-drag';
import { isPathBlockedByFileOperations, type PendingFileOperation } from './file-operation-state';
import {
    focusAdjacentTreeItem,
    focusParentTreeItem,
    focusTreeItemEdge,
} from './file-tree-navigation';
import { BUSY_DISABLED_REASON, type EditRequest } from './file-tree-item-types';
import { parentDirectoryPath } from './file-tree-refresh';

export interface UseFileTreeItemInteractionsOptions {
    clearFocusPath: () => void;
    depth: number;
    editing?: EditRequest;
    entry: FileEntry;
    focusPath?: string;
    index: number;
    operations: readonly PendingFileOperation[];
    projectId: string;
    selectedPath?: string;
    sessionId: string;
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
    setExpanded: Dispatch<SetStateAction<boolean>>;
    setIsDropTarget: Dispatch<SetStateAction<boolean>>;
    startCreate: (itemKind: 'file' | 'directory') => void;
    startRename: () => void;
    symlinkReasonId: string;
}

/**
 * Owns every non-render concern for a single file-tree row: clipboard/drag-and-drop handlers,
 * rename/create entry points, roving-tabindex bookkeeping, and the keyboard shortcut map. Split
 * out of `FileTreeItem` purely to keep that component's JSX readable — every return here is
 * consumed directly by the row's DOM attributes/handlers, so this hook does not change any
 * rendered output or handler semantics.
 */
export function useFileTreeItemInteractions({
    clearFocusPath,
    depth,
    editing,
    entry,
    focusPath,
    index,
    operations,
    projectId,
    selectedPath,
    sessionId,
    setEditing,
    setSelectedPath,
}: UseFileTreeItemInteractionsOptions): UseFileTreeItemInteractionsResult {
    const [expanded, setExpanded] = useState(false);
    const [isDropTarget, setIsDropTarget] = useState(false);
    const rowRef = useRef<HTMLButtonElement>(null);
    const symlinkReasonId = useId();
    const clipboard = useFileClipboardStore((state) => state.entry);
    const isRenaming = editing?.kind === 'rename' && editing.entry.path === entry.path;
    const editable = entry.kind !== 'symlink';
    const parentDirectory = parentDirectoryPath(entry.path);
    const pasteDirectory = entry.kind === 'directory' ? entry.path : parentDirectory;
    const clipboardEmpty = !clipboard || clipboard.projectId !== projectId;
    const pasteBlocked = isPathBlockedByFileOperations(operations, projectId, pasteDirectory);
    const pasteDisabled = clipboardEmpty || pasteBlocked;
    const pasteDisabledReason = clipboardEmpty
        ? 'Nothing to paste'
        : pasteBlocked
          ? BUSY_DISABLED_REASON
          : undefined;
    const duplicateBlocked = isPathBlockedByFileOperations(operations, projectId, parentDirectory);
    const dragBlocked =
        isPathBlockedByFileOperations(operations, projectId, entry.path) ||
        isPathBlockedByFileOperations(operations, projectId, parentDirectory);
    /**
     * Roving tabindex: exactly one row in the whole tree is a Tab stop. The selected row owns it;
     * with no selection, the very first root-level row is the fallback so Tab always lands
     * somewhere sensible instead of nowhere.
     */
    const isRovingTabStop = selectedPath ? selectedPath === entry.path : depth === 0 && index === 0;

    const startRename = (): void => {
        if (editable) setEditing({ kind: 'rename', entry });
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
        if (await trashFile(sessionId, entry.path)) {
            setSelectedPath(undefined);
            setEditing(undefined);
        }
    };
    const dropIntoDirectory = (event: DragEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        setIsDropTarget(false);
        const source = dragPath(event);
        if (pasteBlocked) return;
        if (!source || entry.kind !== 'directory') return;
        void moveFile(sessionId, source, entry.path).then((moved) => {
            if (moved) setSelectedPath(moved.path);
        });
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
            if (entry.kind === 'directory' && expanded) setExpanded(false);
            else focusParentTreeItem(event.currentTarget);
            return;
        }
        if (event.key === 'Enter' && editable) {
            event.preventDefault();
            event.stopPropagation();
            startRename();
            return;
        }
        if (!event.metaKey || !editable) return;
        const key = event.key.toLowerCase();
        if (!['backspace', 'c', 'v', 'x'].includes(key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (key === 'backspace') void confirmTrash();
        else if (key === 'c') rememberFile(projectId, entry.path, 'copy');
        else if (key === 'x') rememberFile(projectId, entry.path, 'cut');
        else if (!pasteBlocked) void pasteIntoEntry();
    };

    useEffect(() => {
        if (focusPath !== entry.path || isRenaming) return;
        rowRef.current?.focus();
        clearFocusPath();
    }, [clearFocusPath, entry.path, focusPath, isRenaming]);

    return {
        clipboard,
        confirmTrash,
        dragBlocked,
        dropIntoDirectory,
        duplicateBlocked,
        duplicateEntry,
        editable,
        expanded,
        handleKeyDown,
        isDropTarget,
        isRenaming,
        isRovingTabStop,
        openEntry,
        parentDirectory,
        pasteBlocked,
        pasteDisabled,
        pasteDisabledReason,
        pasteIntoEntry,
        rowRef,
        setExpanded,
        setIsDropTarget,
        startCreate,
        startRename,
        symlinkReasonId,
    };
}
