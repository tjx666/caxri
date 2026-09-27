import type { Dispatch, DragEvent, KeyboardEvent, RefObject, SetStateAction } from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import type { FileEntry } from '@caxri/protocol';

import { dragPath } from '../../../../lib/file-drag';
import { resolveEntryKind } from '../../../../lib/file-entry';
import { parentDirectoryPath } from '../../../../lib/file-path';
import { tryCommand } from '../../../../stores/toasts';
import { openFileForSession } from '../../../editor/document-commands';
import { useResourceExplorerClient } from '../../controlled-view-context';
import { didTrashFile, duplicateFile, moveFile, pasteFile, rememberFile } from '../file-actions';
import type { FileClipboardEntry } from '../file-clipboard';
import { useFileClipboardStore } from '../file-clipboard';
import { useIsPathBlockedByFileOperations } from '../file-operation-state';
import type { EditRequest } from '../file-tree-item-types';
import { useFileTreeNavigator } from '../file-tree-navigation-context';
import {
    activeResourceExplorerScope,
    setScopeFocusPath,
    setScopePathExpanded,
    setScopeSelectedPath,
    setScopeSubtreeExpanded,
    useResourceExplorerScopeStore,
} from '../resource-explorer-scope-store';
import { isFileTreeDirectory } from '../resource-explorer-state';

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
 * component's JSX readable — every return here is consumed directly by the row's DOM attributes/handlers.
 *
 * The active scope (`scopeId`, `sessionId`) is read from the store at call time rather than taken as an option: it is
 * needed only by the handlers and effects below, never by rendered output, and passing it in would re-render every row
 * on a Session switch. See `resource-explorer-scope-store`.
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
    setEditing,
}: UseFileTreeItemInteractionsOptions): UseFileTreeItemInteractionsResult {
    const client = useResourceExplorerClient();
    const navigator = useFileTreeNavigator();
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
    const isDirectory = isFileTreeDirectory(entry, resolvedKind, expanded);
    const parentDirectory = parentDirectoryPath(entry.path);
    const pasteDirectory = entry.kind === 'directory' ? entry.path : parentDirectory;
    const isClipboardEmpty = !clipboard || clipboard.projectId !== projectId;
    const isPasteBlocked = useIsPathBlockedByFileOperations(projectId, pasteDirectory);
    const isPasteDisabled = isClipboardEmpty || isPasteBlocked;
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
    ): void => {
        const scope = activeResourceExplorerScope();
        if (scope) setScopePathExpanded(scope.scopeId, entry.path, isNextExpanded);
    };
    const setSelectedPath = (path?: string): void => {
        const scope = activeResourceExplorerScope();
        if (scope) setScopeSelectedPath(scope.scopeId, path);
    };
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
        const scope = activeResourceExplorerScope();
        if (!scope) return;
        const { scopeId, sessionId } = scope;
        setSelectedPath(entry.path);
        const intent = ++activation.current;
        await tryCommand('Unable to open path', async () => {
            const kind = await resolveEntryKind(sessionId, entry);
            // A slow link probe must not replace a newer row selection or activation, nor act on a Session the user
            // has since switched away from.
            if (
                intent !== activation.current ||
                activeResourceExplorerScope()?.scopeId !== scopeId ||
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
        const scope = activeResourceExplorerScope();
        const currentClipboard = useFileClipboardStore.getState().entry;
        if (!scope || !currentClipboard) return;
        const pasted = await pasteFile(
            client,
            scope.sessionId,
            projectId,
            pasteDirectory,
            currentClipboard,
        );
        if (pasted) setSelectedPath(pasted.path);
    };
    const duplicateEntry = async (): Promise<void> => {
        const scope = activeResourceExplorerScope();
        if (!scope) return;
        const copied = await duplicateFile(client, scope.sessionId, entry.path);
        if (copied) setSelectedPath(copied.path);
    };
    const confirmTrash = async (): Promise<void> => {
        const scope = activeResourceExplorerScope();
        if (!scope || !(await didTrashFile(client, scope.sessionId, entry.path))) {
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
        const scope = activeResourceExplorerScope();
        const source = dragPath(event);
        if (!scope || !source || entry.kind !== 'directory') return;
        const moved = await moveFile(client, scope.sessionId, source, entry.path);
        if (moved) setSelectedPath(moved.path);
    };
    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            navigator.move(entry.path, 'next');
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            navigator.move(entry.path, 'previous');
            return;
        }
        if (event.key === 'Home') {
            event.preventDefault();
            navigator.move(entry.path, 'first');
            return;
        }
        if (event.key === 'End') {
            event.preventDefault();
            navigator.move(entry.path, 'last');
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
            } else navigator.move(entry.path, 'next');
            return;
        }
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            if (expanded && isDirectory) setExpanded(false);
            else navigator.move(entry.path, 'parent');
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

    /*
     * Runs off a store-derived boolean that is already scope-aware, so the scope is read rather than listed as a
     * dependency: adding it would re-fire every row's effect on a Session switch that changed nothing about that row.
     *
     * A focus request may target a row the virtualizer has not mounted yet; the tree scrolls it into view first, and
     * this effect then fires on mount. `preventScroll` keeps the browser from re-scrolling a row the tree already
     * placed below its sticky ancestors, which native `focus()` scrolling knows nothing about.
     */
    useEffect(() => {
        if (isRenaming || !isFocusRequested) return;
        const scope = activeResourceExplorerScope();
        if (!scope) return;
        rowReference.current?.focus({ preventScroll: true });
        setScopeFocusPath(scope.scopeId, undefined);
    }, [isFocusRequested, isRenaming]);

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
        pasteIntoEntry,
        rowDescriptionId,
        rowRef: rowReference,
        setIsDropTarget,
        startCreate,
        startRename,
    };
}
