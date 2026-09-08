import type { DragEvent, RefCallback } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ProjectRecord, SessionRecord } from '@caxri/protocol';

import { executeCommand } from '../../../commands/execute';
import { dragPath, hasDraggedPath } from '../../../lib/file-drag';
import { queryClient } from '../../../queries/client';
import { useSelectedSession, useSelectedWorkbenchProject } from '../../../stores/selectors';
import {
    useControlledView,
    useControlledViewActionCommand,
    useResourceExplorerClient,
} from '../controlled-view-context';
import { subscribeCoreViewCommands } from '../core-view-commands';
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
import { closeFileSearch, requestFileSearchFocus, useFileSearchStore } from './file-search-state';
import {
    collapseScope,
    setScopeFocusPath,
    setScopeSelectedPath,
} from './resource-explorer-scope-store';
import { fileOperationsForProject, fileTreeRootCaption } from './resource-explorer-state';

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

export interface ResourceExplorerController {
    cancelPendingOperation: () => void;
    collapseFolders: () => void;
    collapseRevision: number;
    createRootFile: () => void;
    createRootFolder: () => void;
    dropIntoProjectRoot: (event: DragEvent) => void;
    editing: EditRequest | undefined;
    fileCaptionRef: RefCallback<HTMLDivElement>;
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
    session: SessionRecord;
    setEditing: (request?: EditRequest) => void;
    toggleSearch: () => void;
}

/**
 * Owns Session-scoped state and every event workflow for the Files composition root. The presentation layer consumes
 * this stable contract without recreating async sequences or scope transitions in JSX.
 */
export function useResourceExplorerController(): ResourceExplorerController | undefined {
    const client = useResourceExplorerClient();
    const { viewId } = useControlledView();
    const createFileCommand = useControlledViewActionCommand('resource.createFile');
    const createFolderCommand = useControlledViewActionCommand('resource.createFolder');
    const searchCommand = useControlledViewActionCommand('resource.search');
    const collapseCommand = useControlledViewActionCommand('resource.collapse');
    const session = useSelectedSession();
    const project = useSelectedWorkbenchProject();
    const sessionId = session?.id;
    const scopeId = session ? `${session.id}:${session.workbenchProjectId}` : undefined;
    const clipboard = useFileClipboardStore((state) => state.entry);
    const selectedProjectId = project?.id ?? session?.workbenchProjectId;
    const operations = useFileOperationStore((state) => state.operations);
    // Memoized explicitly: React Compiler leaves this call uncached, and a fresh array here would otherwise churn the
    // controller object (and everything keyed on it) on every render.
    const projectOperations = useMemo(
        () => fileOperationsForProject(operations, selectedProjectId),
        [operations, selectedProjectId],
    );
    const pendingOperation = projectOperations.at(0);
    const isCancelRevealed = useIsCancelRevealed(pendingOperation);
    const fileCaptionReference = useRef<HTMLDivElement>(null);
    const [collapseRevision, setCollapseRevision] = useState(0);
    const [editingState, setEditingState] = useState<{
        request: EditRequest;
        scopeId: string;
    }>();
    const isSearchVisible = useFileSearchStore(
        (state) => Boolean(sessionId) && state.activeSessionId === sessionId,
    );
    const searchFocusRevision = useFileSearchStore((state) => state.focusRevision);
    useEffect(
        () =>
            !session || !scopeId
                ? () => {}
                : subscribeCoreViewCommands(viewId, scopeId, ({ role }) => {
                      switch (role) {
                          case 'resource.search':
                              requestFileSearchFocus(session.id);
                              break;
                          case 'resource.collapse':
                              collapseScope(scopeId);
                              setCollapseRevision((value) => value + 1);
                              break;
                          case 'resource.createFile':
                          case 'resource.createFolder':
                              setEditingState({
                                  scopeId,
                                  request: {
                                      kind: 'create',
                                      directory: session.rootPath,
                                      itemKind:
                                          role === 'resource.createFile' ? 'file' : 'directory',
                                      returnFocus: {
                                          kind: 'caption',
                                          itemKind:
                                              role === 'resource.createFile' ? 'file' : 'directory',
                                      },
                                  },
                              });
                              break;
                          case 'resource.refresh':
                              // eslint-disable-next-line no-void -- React Query owns refetch errors
                              void queryClient.invalidateQueries({
                                  predicate: ({ queryKey }) =>
                                      queryKey[0] === 'viewContainers.viewOperation' &&
                                      (queryKey[1] as { viewId?: string } | undefined)?.viewId ===
                                          viewId,
                              });
                              break;
                          default:
                              break;
                      }
                  }),
        [scopeId, session, viewId],
    );
    useEffect(
        () => () => {
            if (sessionId) closeFileSearch(sessionId);
        },
        [sessionId],
    );

    if (!session || !scopeId) return undefined;

    const projectId = selectedProjectId ?? session.workbenchProjectId;
    const editing = editingState?.scopeId === scopeId ? editingState.request : undefined;
    const setEditing = (request?: EditRequest): void =>
        setEditingState(request ? { request, scopeId } : undefined);
    const setSelectedPath = (path?: string): void => setScopeSelectedPath(scopeId, path);
    const requestFocus = (target: FocusTarget): void => {
        if (target.kind === 'path') {
            setScopeFocusPath(scopeId, target.path);
            return;
        }
        setScopeFocusPath(scopeId, undefined);
        const label = target.itemKind === 'file' ? 'New File' : 'New Folder';
        fileCaptionReference.current
            ?.querySelector<HTMLButtonElement>(`button[aria-label="${CSS.escape(label)}"]`)
            ?.focus();
    };
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
    const rootActionDependencies: ProjectRootFileActionDependencies = {
        draggedPath: dragPath,
        getClipboard: () => useFileClipboardStore.getState().entry,
        move: (sessionId, source, directory) => moveFile(client, sessionId, source, directory),
        paste: (sessionId, projectId, directory, entry) =>
            pasteFile(client, sessionId, projectId, directory, entry),
        selectPath: (path: string) => setSelectedPath(path),
    };

    return {
        cancelPendingOperation: () => {
            if (pendingOperation) discard(cancelFileOperation(client, pendingOperation.id));
        },
        collapseFolders: () => {
            if (collapseCommand) executeCommand(collapseCommand);
        },
        collapseRevision,
        createRootFile: () => {
            if (createFileCommand) executeCommand(createFileCommand);
        },
        createRootFolder: () => {
            if (createFolderCommand) executeCommand(createFolderCommand);
        },
        dropIntoProjectRoot: (event) =>
            discard(dropIntoProjectRoot(event, rootActionContext, rootActionDependencies)),
        editing,
        fileCaptionRef: (node) => {
            fileCaptionReference.current = node;
        },
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
        session,
        setEditing,
        toggleSearch: () => {
            if (isSearchVisible) closeFileSearch(session.id);
            else if (searchCommand) executeCommand(searchCommand);
        },
    };
}

export function rootPasteDisabledReason(
    controller: Pick<ResourceExplorerController, 'isRootPasteBlocked' | 'isRootPasteEmpty'>,
): string | undefined {
    if (controller.isRootPasteEmpty) return 'Nothing to paste';
    if (controller.isRootPasteBlocked) return BUSY_DISABLED_REASON;
    return undefined;
}
