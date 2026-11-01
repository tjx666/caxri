import type {
    Dispatch,
    DragEvent,
    KeyboardEvent,
    MouseEvent,
    RefObject,
    SetStateAction,
} from 'react';
import { useEffect, useId, useRef, useState } from 'react';

import type { FileEntry } from '@caxri/protocol';

import { translate, useTranslation } from '../../../../i18n';
import { dragPaths, osFilePaths, startFilePathDrag } from '../../../../lib/file-drag';
import { resolveEntryKind } from '../../../../lib/file-entry';
import { parentDirectoryPath } from '../../../../lib/file-path';
import { tryCommand } from '../../../../stores/toasts';
import { openFileForSession } from '../../../editor/document-commands';
import { useResourceExplorerClient } from '../../controlled-view-context';
import { duplicateFile } from '../file-actions';
import type { FileClipboardEntry } from '../file-clipboard';
import { useFileClipboardStore } from '../file-clipboard';
import {
    isDragBlockedByFileOperations,
    pasteDisabledReason,
    useFileOperationStore,
    useIsPathBlockedByFileOperations,
} from '../file-operation-state';
import { importOsFiles, moveFiles, pasteIntoDirectory, rememberFiles } from '../file-paste-actions';
import type { EditRequest } from '../file-tree-item-types';
import { useFileTreeNavigator } from '../file-tree-navigation-context';
import {
    clickSelection,
    outermostPaths,
    pathAfterRemoval,
    selectionActionPaths,
    selectPath,
    selectRange,
} from '../file-tree-selection';
import {
    activeResourceExplorerScope,
    revealPathsInScope,
    scopeSelection,
    setScopeFocusPath,
    setScopePathExpanded,
    setScopeSelectedPath,
    setScopeSelection,
    setScopeSubtreeExpanded,
    useResourceExplorerScopeStore,
} from '../resource-explorer-scope-store';
import { isFileTreeDirectory } from '../resource-explorer-state';
import { trashFiles, undoLatestTrash } from '../trash/file-trash-actions';
import { fileTreeDropDirectory } from '../tree-row/file-drop-target';

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
    /**
     * Whether this row leads the selection; only the lead is a Tab stop, however many rows are selected.
     */
    isSelectionLead: boolean;
    projectId: string;
    projectRoot: string;
    setEditing: (editing?: EditRequest) => void;
}

export interface UseFileTreeItemInteractionsResult {
    activateEntry: (options?: {
        preview?: boolean;
        toggleDirectory?: boolean;
        recursive?: boolean;
        directoriesOnly?: boolean;
    }) => Promise<void>;
    /**
     * The entries a row action applies to: the whole selection when this row is part of a multi-selection, otherwise
     * this row alone. Read when the action runs, so a menu built for a stale selection still acts on the current one.
     */
    actionPaths: () => readonly string[];
    clickEntry: (event: MouseEvent) => void;
    clipboard: FileClipboardEntry | undefined;
    confirmTrash: () => Promise<void>;
    copyEntries: (mode: FileClipboardEntry['mode']) => void;
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
    /**
     * Why Paste cannot run into this row's directory, or `undefined` while it can.
     */
    pasteDisabledReason: string | undefined;
    pasteIntoEntry: () => Promise<void>;
    /**
     * Target of the row's `aria-describedby`, carrying whatever the row's own name cannot say: a symlink's reason for
     * being followable, and the Git state the decoration color and status letter show only visually.
     */
    rowDescriptionId: string;
    rowRef: RefObject<HTMLButtonElement | null>;
    /**
     * Right-click keeps a multi-selection the row belongs to, so the menu acts on all of it, and otherwise selects the
     * row alone, as VS Code's Explorer does.
     */
    selectForContextMenu: () => void;
    setIsDropTarget: Dispatch<SetStateAction<boolean>>;
    startDrag: (event: DragEvent) => void;
    startCreate: (itemKind: 'file' | 'directory') => void;
    startRename: () => void;
}

/**
 * Owns every non-render concern for a single file-tree row: clipboard/drag-and-drop handlers, rename/create entry
 * points, roving-tabindex bookkeeping, and the keyboard shortcut map. Split out of `FileTreeItem` purely to keep that
 * component's JSX readable: every return here is consumed directly by the row's DOM attributes/handlers.
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
    isSelectionLead,
    projectId,
    projectRoot,
    setEditing,
}: UseFileTreeItemInteractionsOptions): UseFileTreeItemInteractionsResult {
    const client = useResourceExplorerClient();
    const { t } = useTranslation();
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
    const isClipboardEmpty = !clipboard;
    const isPasteBlocked = useIsPathBlockedByFileOperations(projectId, pasteDirectory);
    const isDuplicateBlocked = useIsPathBlockedByFileOperations(projectId, parentDirectory);
    const isDragBlocked =
        useIsPathBlockedByFileOperations(projectId, entry.path) || isDuplicateBlocked;
    /**
     * Roving tabindex: exactly one row in the whole tree is a Tab stop. The selected row owns it; with no selection,
     * the very first root-level row is the fallback so Tab always lands somewhere sensible instead of nowhere.
     */
    const isRovingTabStop = hasSelection ? isSelectionLead : depth === 0 && index === 0;

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
    /**
     * Selects pasted or dropped entries and scrolls the tree to the last, since a paste into a long folder lands
     * off-screen.
     */
    const revealPaths = (paths: ReadonlyArray<{ path: string }>): void => {
        const scope = activeResourceExplorerScope();
        if (scope)
            revealPathsInScope(
                scope.scopeId,
                projectRoot,
                paths.map((each) => each.path),
            );
    };
    /**
     * Selected entries inside a folder collapsed since are left out, as VS Code drops them: an action covers only the
     * rows the user can see highlighted.
     */
    const actionPaths = (): readonly string[] => {
        const scope = activeResourceExplorerScope();
        if (!scope) return [entry.path];
        return selectionActionPaths(scopeSelection(scope.scopeId), entry.path).filter(
            (path) => path === entry.path || navigator.entryFor(path) !== undefined,
        );
    };
    const copyEntries = (mode: FileClipboardEntry['mode']): void => {
        rememberFiles(actionPaths(), mode);
    };
    const selectForContextMenu = (): void => {
        const scope = activeResourceExplorerScope();
        if (scope && actionPaths().length === 1) setScopeSelectedPath(scope.scopeId, entry.path);
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
        await tryCommand(translate('viewContainers.files.openFailed'), async () => {
            const kind = await resolveEntryKind(sessionId, entry);
            // A slow link probe must not replace a newer row selection or activation, nor act on a Session the user
            // has since switched away from.
            if (
                intent !== activation.current ||
                activeResourceExplorerScope()?.scopeId !== scopeId ||
                useResourceExplorerScopeStore.getState().selectionByScope[scopeId]?.lead !==
                    entry.path
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
        void activateEntry();
    };
    const clickEntry = (event: MouseEvent): void => {
        const scope = activeResourceExplorerScope();
        if (!scope) return;
        const { isActivating, selection } = clickSelection(
            scopeSelection(scope.scopeId),
            entry.path,
            event,
            navigator.visiblePaths(),
        );
        if (isActivating) {
            void activateEntry({ preview: true, toggleDirectory: true, recursive: event.altKey });
            return;
        }
        setScopeSelection(scope.scopeId, selection);
        /**
         * A Cmd-click that removed this row leaves it focused but unselected, so Cmd+C or Cmd+Backspace would act on it
         * rather than on the highlighted rows. Focus follows the lead instead.
         */
        if (selection && !selection.paths.includes(entry.path))
            setScopeFocusPath(scope.scopeId, selection.lead);
    };
    /**
     * Shift+Arrow grows or shrinks the range from the anchor to the row the arrow lands on, and moves focus there.
     */
    const extendSelection = (action: 'next' | 'previous'): void => {
        const scope = activeResourceExplorerScope();
        const target = navigator.pathFor(entry.path, action);
        if (!scope || target === undefined) return;
        const current = scopeSelection(scope.scopeId) ?? selectPath(entry.path);
        setScopeSelection(scope.scopeId, selectRange(current, target, navigator.visiblePaths()));
        navigator.move(entry.path, action);
    };
    /**
     * Drags the whole selection when this row is part of it. A symlink is a reference only, never moved, so a drag that
     * carries one inserts paths into a Terminal or Chat but cannot move anything in Files. A selection holding an entry
     * a running file operation touches is refused, as that row alone would be.
     */
    const startDrag = (event: DragEvent): void => {
        const paths = actionPaths();
        if (
            isDragBlockedByFileOperations(
                useFileOperationStore.getState().operations,
                projectId,
                paths,
            )
        ) {
            event.preventDefault();
            return;
        }
        const dragged = paths.map((path) => ({
            path,
            entry: path === entry.path ? entry : navigator.entryFor(path),
        }));
        startFilePathDrag(
            event.dataTransfer,
            dragged.map((item) => ({
                path: item.path,
                isDirectory:
                    item.entry?.kind === 'directory' || item.entry?.linkKind === 'directory',
            })),
            dragged.every((item) => item.entry !== undefined && item.entry.kind !== 'symlink'),
        );
    };
    const pasteIntoEntry = async (): Promise<void> => {
        const scope = activeResourceExplorerScope();
        if (!scope) return;
        const pasted = await pasteIntoDirectory(client, scope.sessionId, pasteDirectory);
        if (pasted.length > 0) revealPaths(pasted);
    };
    const duplicateEntry = async (): Promise<void> => {
        const scope = activeResourceExplorerScope();
        if (!scope) return;
        const copied = await duplicateFile(client, scope.sessionId, entry.path);
        if (copied) setSelectedPath(copied.path);
    };
    const confirmTrash = async (): Promise<void> => {
        const scope = activeResourceExplorerScope();
        if (!scope) return;
        /**
         * Resolved before the row disappears. The removed row held the keyboard focus, so without a new target the
         * focus drops to the page and Cmd+Z (Undo Move to Trash) would no longer reach the Files tree.
         */
        const paths = actionPaths();
        const survivor =
            rowReference.current === document.activeElement
                ? paths.length === 1
                    ? navigator.pathFor(entry.path, 'afterRemoval')
                    : pathAfterRemoval(navigator.visiblePaths(), paths)
                : undefined;
        const trashed = await trashFiles(client, scope.sessionId, outermostPaths(paths));
        if (trashed.length > 0) {
            setSelectedPath(undefined);
            setEditing(undefined);
            if (survivor !== undefined) setScopeFocusPath(scope.scopeId, survivor);
        }
    };
    const dropIntoDirectory = async (event: DragEvent): Promise<void> => {
        const target = fileTreeDropDirectory(entry);
        // A symlink row is no target; its drop falls through to the tree's Project root target.
        if (target === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        setIsDropTarget(false);
        if (isPasteBlocked) return;
        const scope = activeResourceExplorerScope();
        if (!scope) return;
        const sources = dragPaths(event);
        // Dropping items on a sibling row (or their own folder) targets the folder they already live in: `moveFiles`
        // skips those, since moving them there would only raise a conflict with themselves.
        const dropped =
            sources.length > 0
                ? await moveFiles(client, scope.sessionId, sources, target)
                : await importOsFiles(
                      client,
                      scope.sessionId,
                      osFilePaths(event.dataTransfer.files),
                      target,
                  );
        if (dropped.length > 0) revealPaths(dropped);
    };
    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const action = event.key === 'ArrowDown' ? 'next' : 'previous';
            if (event.shiftKey) extendSelection(action);
            else navigator.move(entry.path, action);
            return;
        }
        if (event.key === 'Escape') {
            // Escape narrows a multi-selection to this row; with one row selected the key is left to the window.
            const scope = activeResourceExplorerScope();
            if (!scope || actionPaths().length === 1) return;
            event.preventDefault();
            event.stopPropagation();
            setScopeSelectedPath(scope.scopeId, entry.path);
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
        if (event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z') {
            // Only a tree row has focus here, so editors, inputs, and Terminals keep their own Cmd+Z. With nothing to
            // undo the keystroke is left alone.
            const scope = activeResourceExplorerScope();
            if (scope && undoLatestTrash(client, scope.sessionId) !== undefined) {
                event.preventDefault();
                event.stopPropagation();
            }
            return;
        }
        if (!isEditable || !event.metaKey) return;
        const key = event.key.toLowerCase();
        if (!['backspace', 'c', 'v', 'x'].includes(key)) return;
        event.preventDefault();
        event.stopPropagation();
        switch (key) {
            case 'backspace': {
                // confirmTrash funnels its own failures into a toast via trashFiles, nothing to
                // await here.
                void confirmTrash();
                break;
            }
            case 'c': {
                copyEntries('copy');
                break;
            }
            case 'x': {
                copyEntries('cut');
                break;
            }
            default: {
                // pasteIntoEntry funnels its own failures into a toast via pasteFile, nothing to
                // await here.
                if (!isPasteBlocked) void pasteIntoEntry();
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
        actionPaths,
        activateEntry,
        clickEntry,
        clipboard,
        confirmTrash,
        copyEntries,
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
        pasteDisabledReason: pasteDisabledReason(
            { isBlocked: isPasteBlocked, isClipboardEmpty },
            t,
        ),
        pasteIntoEntry,
        rowDescriptionId,
        rowRef: rowReference,
        selectForContextMenu,
        setIsDropTarget,
        startDrag,
        startCreate,
        startRename,
    };
}
