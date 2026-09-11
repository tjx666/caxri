import type { Dispatch, DragEvent, KeyboardEvent, RefObject, SetStateAction } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import type { FileEntry } from '@caxri/protocol';

import { dragPath } from '../../../lib/file-drag';
import { isDirectoryEntry, resolveEntryKind } from '../../../lib/file-entry';
import { parentDirectoryPath } from '../../../lib/file-path';
import { tryCommand } from '../../../stores/toasts';
import { openFileForSession } from '../../editor/document-actions';
import { useResourceExplorerClient } from '../controlled-view-context';
import { didTrashFile, duplicateFile, moveFile, pasteFile, rememberFile } from './file-actions';
import type { FileClipboardEntry } from './file-clipboard';
import { useFileClipboardStore } from './file-clipboard';
import { useIsPathBlockedByFileOperations } from './file-operation-state';
import type { EditRequest } from './file-tree-item-types';
import { BUSY_DISABLED_REASON } from './file-tree-item-types';
import {
    focusAdjacentTreeItem,
    focusParentTreeItem,
    focusTreeItemEdge,
} from './file-tree-navigation';
import {
    setScopeFocusPath,
    setScopePathExpanded,
    setScopeSelectedPath,
    setScopeSubtreeExpanded,
    useResourceExplorerScopeStore,
} from './resource-explorer-scope-store';

export interface UseFileTreeItemInteractionsOptions {
    depth: number;
    editing?: EditRequest;
    entry: FileEntry;
    expanded: boolean;
    /**
     * Whether any row in this scope is selected; the roving Tab stop falls back to the first root row otherwise.
     */
    hasSelection: boolean;
    index: number;
    isFocusRequested: boolean;
    isSelected: boolean;
    projectId: string;
    scopeId: string;
    sessionId: string;
    setEditing: (editing?: EditRequest) => void;
}

export interface UseFileTreeItemInteractionsResult {
    activateEntry: (options?: {
        preview?: boolean;
        toggleDirectory?: boolean;
        recursive?: boolean;
        directoriesOnly?: boolean;
    }) => Promise<void>;
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
    isDirectory: boolean;
    isRenaming: boolean;
    isRovingTabStop: boolean;
    openEntry: () => void;
    parentDirectory: string;
    pasteBlocked: boolean;
    pasteDisabled: boolean;
    pasteDisabledReason: string | undefined;
    pasteIntoEntry: () => Promise<void>;
    /**
     * Target of the row's `aria-describedby`, carrying whatever the row's own name cannot say: a symlink's reason for
     * being followable, and the Git state the decoration color and status letter show only visually.
     */
    rowDescriptionId: string;
    rowRef: RefObject<HTMLButtonElement | null>;
    setIsDropTarget: Dispatch<SetStateAction<boolean>>;
    startCreate: (itemKind: 'file' | 'directory') => void;
    startRename: () => void;
}

/**
 * Owns every non-render concern for a single file-tree row: clipboard/drag-and-drop handlers, rename/create entry
 * points, roving-tabindex bookkeeping, and the keyboard shortcut map. Split out of `FileTreeItem` purely to keep that
 * component's JSX readable — every return here is consumed directly by the row's DOM attributes/handlers, so this hook
 * does not change any rendered output or handler semantics.
 */
export function useFileTreeItemInteractions({
    depth,
    editing,
    entry,
    expanded,
    hasSelection,
    index,
    isFocusRequested,
    isSelected,
    projectId,
    scopeId,
    sessionId,
    setEditing,
}: UseFileTreeItemInteractionsOptions): UseFileTreeItemInteractionsResult {
    const client = useResourceExplorerClient();
    const [isDropTarget, setIsDropTarget] = useState(false);
    const rowReference = useRef<HTMLButtonElement>(null);
    const activation = useRef(0);
    useEffect(
        () => () => {
            activation.current += 1;
        },
        [],
    );
    const rowDescriptionId = useId();
    const clipboard = useFileClipboardStore((state) => state.entry);
    const isRenaming = editing?.kind === 'rename' && editing.entry.path === entry.path;
    const isEditable = entry.kind !== 'symlink';
    const [resolvedKind, setResolvedKind] = useState<'file' | 'directory'>();
    const isDirectory =
        resolvedKind && entry.kind === 'symlink'
            ? resolvedKind === 'directory'
            : isDirectoryEntry(entry);
    const parentDirectory = parentDirectoryPath(entry.path);
    const pasteDirectory = entry.kind === 'directory' ? entry.path : parentDirectory;
    const isClipboardEmpty = !clipboard || clipboard.projectId !== projectId;
    const isPasteBlocked = useIsPathBlockedByFileOperations(projectId, pasteDirectory);
    const isPasteDisabled = isClipboardEmpty || isPasteBlocked;
    const pasteDisabledReason = isClipboardEmpty
        ? 'Nothing to paste'
        : isPasteBlocked
          ? BUSY_DISABLED_REASON
          : undefined;
    const isDuplicateBlocked = useIsPathBlockedByFileOperations(projectId, parentDirectory);
    const isDragBlocked =
        useIsPathBlockedByFileOperations(projectId, entry.path) || isDuplicateBlocked;
    /**
     * Roving tabindex: exactly one row in the whole tree is a Tab stop. The selected row owns it; with no selection,
     * the very first root-level row is the fallback so Tab always lands somewhere sensible instead of nowhere.
     */
    const isRovingTabStop = hasSelection ? isSelected : depth === 0 && index === 0;

    const setExpanded = (
        isNextExpanded: boolean | ((isCurrentExpanded: boolean) => boolean),
    ): void => setScopePathExpanded(scopeId, entry.path, isNextExpanded);
    const setSelectedPath = (path?: string): void => setScopeSelectedPath(scopeId, path);
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
    const activateEntry: UseFileTreeItemInteractionsResult['activateEntry'] = async (
        options = {},
    ) => {
        setSelectedPath(entry.path);
        const intent = ++activation.current;
        await tryCommand('Unable to open path', async () => {
            const kind = await resolveEntryKind(sessionId, entry);
            // A slow link probe must not replace a newer row selection or activation.
            if (
                intent !== activation.current ||
                useResourceExplorerScopeStore.getState().selectionByScope[scopeId] !== entry.path
            )
                return;
            setResolvedKind(kind);
            if (kind === 'directory') {
                const isNextExpanded = options.toggleDirectory ? !expanded : true;
                if (options.recursive)
                    setScopeSubtreeExpanded(
                        scopeId,
                        client.viewId,
                        projectId,
                        entry.path,
                        isNextExpanded,
                    );
                else setExpanded(isNextExpanded);
            } else if (!options.directoriesOnly)
                await openFileForSession(sessionId, entry.path, { preview: options.preview });
        });
    };
    const openEntry = (): void => {
        // eslint-disable-next-line no-void -- activateEntry owns error presentation
        void activateEntry();
    };
    const pasteIntoEntry = async (): Promise<void> => {
        const currentClipboard = useFileClipboardStore.getState().entry;
        if (!currentClipboard) return;
        const pasted = await pasteFile(
            client,
            sessionId,
            projectId,
            pasteDirectory,
            currentClipboard,
        );
        if (pasted) setSelectedPath(pasted.path);
    };
    const duplicateEntry = async (): Promise<void> => {
        const copied = await duplicateFile(client, sessionId, entry.path);
        if (copied) setSelectedPath(copied.path);
    };
    const confirmTrash = async (): Promise<void> => {
        if (!(await didTrashFile(client, sessionId, entry.path))) {
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
        const moved = await moveFile(client, sessionId, source, entry.path);
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
            if (!isDirectory && entry.kind !== 'symlink') return;
            event.preventDefault();
            // Collapsed -> expand in place; already expanded -> move focus into the first child,
            // matching the standard ARIA treeview keyboard pattern.
            if (!expanded) {
                // eslint-disable-next-line no-void -- activateEntry owns error presentation
                void activateEntry({ directoriesOnly: true });
            } else focusAdjacentTreeItem(event.currentTarget, 1);
            return;
        }
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            if (expanded && isDirectory) setExpanded(false);
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
        if (isRenaming || !isFocusRequested) return;
        rowReference.current?.focus();
        setScopeFocusPath(scopeId, undefined);
    }, [isFocusRequested, isRenaming, scopeId]);

    return {
        activateEntry,
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
        isDirectory,
        isRenaming,
        isRovingTabStop,
        openEntry,
        parentDirectory,
        pasteBlocked: isPasteBlocked,
        pasteDisabled: isPasteDisabled,
        pasteDisabledReason,
        pasteIntoEntry,
        rowDescriptionId,
        rowRef: rowReference,
        setIsDropTarget,
        startCreate,
        startRename,
    };
}
