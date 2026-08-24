import type { DragEvent, RefCallback } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { ProjectRecord, SessionRecord } from '@shared/types';

import { executeCommand } from '../../../../commands/execute';
import { dragPath, hasDraggedPath } from '../../../../lib/file-drag';
import { useSelectedSession, useSelectedWorkbenchProject } from '../../../../stores/selectors';
import type { EditRequest, FocusTarget } from './directory-entries';
import { BUSY_DISABLED_REASON } from './directory-entries';
import { cancelFileOperation, moveFile, pasteFile } from './file-actions';
import { useFileClipboardStore } from './file-clipboard';
import type { PendingFileOperation } from './file-operation-state';
import {
    CANCEL_REVEAL_THRESHOLD_MS,
    isPathBlockedByFileOperations,
    useFileOperationStore,
} from './file-operation-state';
import { closeFileSearch, useFileSearchStore } from './file-search-state';
import {
    fileOperationsForProject,
    fileTreeRootCaption,
    scopedValue,
    setScopedPathExpanded,
    setScopedValue,
} from './file-tree-panel-state';

/**
 * Every caller fires an already-tracked file action whose own `tryCommand` path reports failures via a toast.
 */
function discard(promise: Promise<unknown>): void {
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void promise;
}

/**
 * The Cancel affordance stays hidden for fast operations. Scheduling even the already-past-threshold update keeps
 * React's render and effect phases pure, matching the shared debounced-value lifecycle.
 */
function useIsCancelRevealed(operation: PendingFileOperation | undefined): boolean {
    const [isRevealed, setIsRevealed] = useState(false);
    const isCancelable = operation?.cancelable ?? false;
    const startedAt = operation?.startedAt;
    useEffect(() => {
        if (!isCancelable || startedAt === undefined) {
            const timer = setTimeout(() => setIsRevealed(false), 0);
            return () => clearTimeout(timer);
        }
        const remaining = startedAt + CANCEL_REVEAL_THRESHOLD_MS - Date.now();
        const timer = setTimeout(() => setIsRevealed(true), Math.max(remaining, 0));
        return () => clearTimeout(timer);
    }, [isCancelable, startedAt]);
    return isRevealed;
}

export interface FileTreePanelController {
    cancelPendingOperation: () => void;
    clearFocusPath: () => void;
    collapseFolders: () => void;
    collapseRevision: number;
    createRootFile: () => void;
    createRootFolder: () => void;
    dropIntoProjectRoot: (event: DragEvent) => void;
    editing: EditRequest | undefined;
    expandedPaths: Set<string>;
    fileCaptionRef: RefCallback<HTMLDivElement>;
    focusPath: string | undefined;
    isCancelRevealed: boolean;
    isRootPasteDisabled: boolean;
    isRootPasteEmpty: boolean;
    isRootPasteBlocked: boolean;
    isSearchVisible: boolean;
    onProjectRootDragOver: (event: DragEvent) => void;
    pasteIntoProjectRoot: () => void;
    pendingOperation: PendingFileOperation | undefined;
    project: ProjectRecord | undefined;
    projectId: string;
    projectOperations: PendingFileOperation[];
    requestFocus: (target: FocusTarget) => void;
    rootPathCaption: string;
    scopeId: string;
    searchFocusRevision: number;
    selectedPath: string | undefined;
    session: SessionRecord;
    setEditing: (request?: EditRequest) => void;
    setPathExpanded: (
        path: string,
        isNextExpanded: boolean | ((isCurrentExpanded: boolean) => boolean),
    ) => void;
    setSelectedPath: (path?: string) => void;
    toggleSearch: () => void;
}

/**
 * Owns Session-scoped state and every event workflow for the Files composition root. The presentation layer consumes
 * this stable contract without recreating async sequences or scope transitions in JSX.
 */
export function useFileTreePanelController(): FileTreePanelController | undefined {
    const session = useSelectedSession();
    const project = useSelectedWorkbenchProject();
    const sessionId = session?.id;
    const scopeId = session ? `${session.id}:${session.workbenchProjectId}` : undefined;
    const clipboard = useFileClipboardStore((state) => state.entry);
    const selectedProjectId = project?.id ?? session?.workbenchProjectId;
    const operations = useFileOperationStore((state) => state.operations);
    const projectOperations = fileOperationsForProject(operations, selectedProjectId);
    const pendingOperation = projectOperations.at(0);
    const isCancelRevealed = useIsCancelRevealed(pendingOperation);
    const fileCaptionReference = useRef<HTMLDivElement>(null);
    const [collapseRevision, setCollapseRevision] = useState(0);
    const [expandedByScope, setExpandedByScope] = useState<Record<string, string[]>>({});
    const [editingState, setEditingState] = useState<{
        request: EditRequest;
        scopeId: string;
    }>();
    const [focusByScope, setFocusByScope] = useState<Record<string, string | undefined>>({});
    const [selectionByScope, setSelectionByScope] = useState<Record<string, string | undefined>>(
        {},
    );
    const isSearchVisible = useFileSearchStore(
        (state) => Boolean(sessionId) && state.activeSessionId === sessionId,
    );
    const searchFocusRevision = useFileSearchStore((state) => state.focusRevision);

    if (!session || !scopeId) return undefined;

    const projectId = selectedProjectId ?? session.workbenchProjectId;
    const editing = editingState?.scopeId === scopeId ? editingState.request : undefined;
    const focusPath = scopedValue(focusByScope, scopeId);
    const selectedPath = scopedValue(selectionByScope, scopeId);
    const setEditing = (request?: EditRequest): void =>
        setEditingState(request ? { request, scopeId } : undefined);
    const setSelectedPath = (path?: string): void =>
        setSelectionByScope((current) => setScopedValue(current, scopeId, path));
    const clearFocusPath = (): void =>
        setFocusByScope((current) => setScopedValue(current, scopeId, undefined));
    const requestFocus = (target: FocusTarget): void => {
        if (target.kind === 'path') {
            setFocusByScope((current) => setScopedValue(current, scopeId, target.path));
            return;
        }
        clearFocusPath();
        const label = target.itemKind === 'file' ? 'New File' : 'New Folder';
        fileCaptionReference.current
            ?.querySelector<HTMLButtonElement>(`button[aria-label="${CSS.escape(label)}"]`)
            ?.focus();
    };
    const setPathExpanded = (
        path: string,
        isNextExpanded: boolean | ((isCurrentExpanded: boolean) => boolean),
    ): void =>
        setExpandedByScope((current) =>
            setScopedPathExpanded(current, scopeId, path, isNextExpanded),
        );
    const startCreatingRootItem = (itemKind: 'file' | 'directory'): void =>
        setEditing({
            kind: 'create',
            directory: session.rootPath,
            itemKind,
            returnFocus: { kind: 'caption', itemKind },
        });
    const isRootPasteEmpty = !clipboard || clipboard.projectId !== projectId;
    const isRootPasteBlocked = isPathBlockedByFileOperations(
        projectOperations,
        projectId,
        session.rootPath,
    );
    const performPasteIntoProjectRoot = async (): Promise<void> => {
        const currentClipboard = useFileClipboardStore.getState().entry;
        if (!currentClipboard) return;
        const pasted = await pasteFile(session.id, projectId, session.rootPath, currentClipboard);
        if (pasted) setSelectedPath(pasted.path);
    };
    const performDropIntoProjectRoot = async (event: DragEvent): Promise<void> => {
        event.preventDefault();
        if (isRootPasteBlocked) return;
        const source = dragPath(event);
        if (!source) return;
        const moved = await moveFile(session.id, source, session.rootPath);
        if (moved) setSelectedPath(moved.path);
    };

    return {
        cancelPendingOperation: () => {
            if (pendingOperation) discard(cancelFileOperation(pendingOperation.id));
        },
        clearFocusPath,
        collapseFolders: () => {
            setExpandedByScope((current) => setScopedValue(current, scopeId, []));
            setCollapseRevision((value) => value + 1);
        },
        collapseRevision,
        createRootFile: () => startCreatingRootItem('file'),
        createRootFolder: () => startCreatingRootItem('directory'),
        dropIntoProjectRoot: (event) => discard(performDropIntoProjectRoot(event)),
        editing,
        expandedPaths: new Set(expandedByScope[scopeId]),
        fileCaptionRef: (node) => {
            fileCaptionReference.current = node;
        },
        focusPath,
        isCancelRevealed,
        isRootPasteDisabled: isRootPasteEmpty || isRootPasteBlocked,
        isRootPasteEmpty,
        isRootPasteBlocked,
        isSearchVisible,
        onProjectRootDragOver: (event) => {
            if (isRootPasteBlocked || !hasDraggedPath(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
        },
        pasteIntoProjectRoot: () => discard(performPasteIntoProjectRoot()),
        pendingOperation,
        project,
        projectId,
        projectOperations,
        requestFocus,
        rootPathCaption: fileTreeRootCaption(session.rootPath),
        scopeId,
        searchFocusRevision,
        selectedPath,
        session,
        setEditing,
        setPathExpanded,
        setSelectedPath,
        toggleSearch: () => {
            if (isSearchVisible) closeFileSearch(session.id);
            else executeCommand('secondarySidebar.searchFiles');
        },
    };
}

export function rootPasteDisabledReason(
    controller: Pick<FileTreePanelController, 'isRootPasteBlocked' | 'isRootPasteEmpty'>,
): string | undefined {
    if (controller.isRootPasteEmpty) return 'Nothing to paste';
    if (controller.isRootPasteBlocked) return BUSY_DISABLED_REASON;
    return undefined;
}
