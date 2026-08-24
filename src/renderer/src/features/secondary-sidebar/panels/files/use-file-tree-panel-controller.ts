import type { DragEvent, RefCallback } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { ProjectRecord, SessionRecord } from '@shared/types';

import { executeCommand } from '../../../../commands/execute';
import { dragPath, hasDraggedPath } from '../../../../lib/file-drag';
import { useSelectedSession, useSelectedWorkbenchProject } from '../../../../stores/selectors';
import type { EditRequest, FocusTarget } from './directory-entries';
import { BUSY_DISABLED_REASON } from './directory-entries';
import { cancelFileOperation, moveFile, pasteFile } from './file-actions';
import type { FileClipboardEntry } from './file-clipboard';
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

interface ProjectRootFileActionContext {
    isBlocked: boolean;
    projectId: string;
    rootPath: string;
    sessionId: string;
}

interface ProjectRootFileActionDependencies {
    draggedPath: (event: DragEvent) => string | undefined;
    getClipboard: () => FileClipboardEntry | undefined;
    move: (
        sessionId: string,
        source: string,
        directory: string,
    ) => Promise<{ path: string } | undefined>;
    paste: (
        sessionId: string,
        projectId: string,
        directory: string,
        clipboard: FileClipboardEntry,
    ) => Promise<{ path: string } | undefined>;
    selectPath: (path: string) => void;
}

export async function pasteIntoProjectRoot(
    context: ProjectRootFileActionContext,
    dependencies: ProjectRootFileActionDependencies,
): Promise<void> {
    const clipboard = dependencies.getClipboard();
    if (!clipboard) return;
    const pasted = await dependencies.paste(
        context.sessionId,
        context.projectId,
        context.rootPath,
        clipboard,
    );
    if (pasted) dependencies.selectPath(pasted.path);
}

export async function dropIntoProjectRoot(
    event: DragEvent,
    context: ProjectRootFileActionContext,
    dependencies: ProjectRootFileActionDependencies,
): Promise<void> {
    event.preventDefault();
    if (context.isBlocked) return;
    const source = dependencies.draggedPath(event);
    if (!source) return;
    const moved = await dependencies.move(context.sessionId, source, context.rootPath);
    if (moved) dependencies.selectPath(moved.path);
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
    const rootActionContext = {
        isBlocked: isRootPasteBlocked,
        projectId,
        rootPath: session.rootPath,
        sessionId: session.id,
    };
    const rootActionDependencies = {
        draggedPath: dragPath,
        getClipboard: () => useFileClipboardStore.getState().entry,
        move: moveFile,
        paste: pasteFile,
        selectPath: (path: string) => setSelectedPath(path),
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
        dropIntoProjectRoot: (event) =>
            discard(dropIntoProjectRoot(event, rootActionContext, rootActionDependencies)),
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
        pasteIntoProjectRoot: () =>
            discard(pasteIntoProjectRoot(rootActionContext, rootActionDependencies)),
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
