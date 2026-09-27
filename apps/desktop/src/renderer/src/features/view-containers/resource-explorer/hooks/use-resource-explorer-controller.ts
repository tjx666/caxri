import type { DragEvent, RefCallback } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ProjectRecord, SessionRecord } from '@caxri/protocol';
import { useIsFetching } from '@tanstack/react-query';

import { executeCommand } from '../../../../commands/execute';
import { dragPath, hasDraggedPath } from '../../../../lib/file-drag';
import { CONTROLLED_VIEW_QUERY_METHOD, queryClient } from '../../../../queries/client';
import { useSelectedSession, useSelectedWorkbenchProject } from '../../../../stores/selectors';
import { useActivePaneTab } from '../../../workbench/pane-actions';
import {
    useControlledView,
    useControlledViewActionCommand,
    useResourceExplorerClient,
} from '../../controlled-view-context';
import { subscribeCoreViewCommands } from '../../core-view-commands';
import { useIsViewContainerActive } from '../../view-container-activity';
import { cancelFileOperation, moveFile, pasteFile } from '../file-actions';
import type { FileClipboardEntry } from '../file-clipboard';
import { useFileClipboardStore } from '../file-clipboard';
import type { PendingFileOperation } from '../file-operation-state';
import {
    CANCEL_REVEAL_THRESHOLD_MS,
    isPathBlockedByFileOperations,
    useFileOperationStore,
} from '../file-operation-state';
import type { EditRequest, FocusTarget } from '../file-tree-item-types';
import {
    activeResourceExplorerScope,
    clearScopeRevealPath,
    collapseScope,
    didRevealPathInScope,
    setResourceExplorerActiveScope,
    setScopeFocusPath,
    setScopeSelectedPath,
    subscribeResourceExplorerScopePruning,
} from '../resource-explorer-scope-store';
import { fileOperationsForProject, fileTreeRootCaption } from '../resource-explorer-state';

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

/**
 * What the Files title bar's Refresh does: re-read the disk, then put the tree back around the open file.
 *
 * The reveal is half the action rather than a side effect of it. Re-reading answers "what is there now?", and the
 * answer somebody is looking for is nearly always positioned relative to the file they are already in — so the tree
 * that comes back expands to it and selects it instead of making them walk the folders down again. VS Code's explorer
 * behaves the same way.
 *
 * Written as a function taking its inputs because the reveal cannot live in the controller's reveal effect: none of
 * that effect's inputs move when the button is pressed, so nothing there would re-fire.
 */
export function refreshResourceExplorer(
    target: {
        /**
         * The file the active editor tab is showing, when it is a file at all.
         */
        activeFilePath?: string;
        scopeId?: string;
        sessionRootPath?: string;
    },
    dependencies: {
        revealPath: (scopeId: string, projectRoot: string, path: string) => void;
        runRefresh: () => void;
    },
): void {
    dependencies.runRefresh();
    if (target.scopeId && target.sessionRootPath && target.activeFilePath)
        dependencies.revealPath(target.scopeId, target.sessionRootPath, target.activeFilePath);
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
    /**
     * At least one directory listing for this view is in flight. The header spins its Refresh glyph on it, which is the
     * only feedback a re-read gives when the tree comes back unchanged.
     */
    isRefreshing: boolean;
    isRootPasteDisabled: boolean;
    isRootPasteEmpty: boolean;
    isRootPasteBlocked: boolean;
    onProjectRootDragOver: (event: DragEvent) => void;
    pasteIntoProjectRoot: () => void;
    pendingOperation: PendingFileOperation | undefined;
    project: ProjectRecord | undefined;
    projectId: string;
    projectOperations: PendingFileOperation[];
    /**
     * Re-reads every listed directory from disk. Deliberately not paired with `collapseRevision`: expansion and
     * selection live in the scope store rather than in the query cache, so invalidating the listings leaves the tree
     * open exactly where the user left it — including the path down to the file the editor has open.
     */
    refreshFiles: () => void;
    requestFocus: (target: FocusTarget) => void;
    rootPathCaption: string;
    scopeId: string;
    session: SessionRecord;
    setEditing: (request?: EditRequest) => void;
}

/**
 * Owns Session-scoped state and every event workflow for the Files composition root. The presentation layer consumes
 * this stable contract without recreating async sequences or scope transitions in JSX.
 */
export function useResourceExplorerController(): ResourceExplorerController | undefined {
    const client = useResourceExplorerClient();
    const { viewId } = useControlledView();
    const isContainerActive = useIsViewContainerActive();
    const activeResource = useActivePaneTab()?.resource;
    const activeFilePath = activeResource?.kind === 'file' ? activeResource.path : undefined;
    const createFileCommand = useControlledViewActionCommand('resource.createFile');
    const createFolderCommand = useControlledViewActionCommand('resource.createFolder');
    const collapseCommand = useControlledViewActionCommand('resource.collapse');
    const refreshCommand = useControlledViewActionCommand('resource.refresh');
    const session = useSelectedSession();
    const project = useSelectedWorkbenchProject();
    const sessionRootPath = session?.rootPath;
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
    // Matches the same queries `resource.refresh` invalidates below, so the glyph spins for exactly the work the
    // button started — and equally for a listing React Query refetched on its own.
    const isRefreshing =
        useIsFetching({
            predicate: ({ queryKey }) =>
                queryKey[0] === CONTROLLED_VIEW_QUERY_METHOD &&
                (queryKey[1] as { viewId?: string } | undefined)?.viewId === viewId,
        }) > 0;
    const fileCaptionReference = useRef<HTMLDivElement>(null);
    const [collapseRevision, setCollapseRevision] = useState(0);
    const [editingState, setEditingState] = useState<{
        request: EditRequest;
        scopeId: string;
    }>();
    /**
     * Publishes the scope the mounted tree draws, before paint so the rows read the new Session's expansion and
     * selection in the same frame the switch lands. Rows subscribe to their own booleans rather than to this value, so
     * republishing re-renders only the rows whose state actually differs between the two Sessions — the tree itself
     * skips the controller's own re-render entirely, because it no longer takes the scope as a prop.
     */
    useLayoutEffect(() => {
        setResourceExplorerActiveScope(
            session && scopeId
                ? {
                      projectId: selectedProjectId ?? session.workbenchProjectId,
                      scopeId,
                      sessionId: session.id,
                  }
                : undefined,
        );
    }, [scopeId, selectedProjectId, session]);
    useEffect(() => () => setResourceExplorerActiveScope(undefined), []);
    useEffect(() => {
        if (!isContainerActive || !scopeId || !sessionRootPath || !activeFilePath) {
            if (scopeId) clearScopeRevealPath(scopeId);
            return;
        }
        if (!didRevealPathInScope(scopeId, sessionRootPath, activeFilePath))
            clearScopeRevealPath(scopeId);
    }, [activeFilePath, isContainerActive, scopeId, sessionRootPath]);
    useEffect(
        () => () => {
            if (scopeId) clearScopeRevealPath(scopeId);
        },
        [scopeId],
    );
    useEffect(
        () =>
            !session || !scopeId
                ? () => {}
                : subscribeCoreViewCommands(viewId, scopeId, ({ role }) => {
                      switch (role) {
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
                                      queryKey[0] === CONTROLLED_VIEW_QUERY_METHOD &&
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
    useEffect(() => subscribeResourceExplorerScopePruning(), []);

    if (!session || !scopeId) return undefined;

    const projectId = selectedProjectId ?? session.workbenchProjectId;
    const editing = editingState?.scopeId === scopeId ? editingState.request : undefined;
    /**
     * These two reach the tree as props, so they read the scope from the store instead of capturing it. Capturing
     * `scopeId` gave them a new identity on every Session switch, which re-rendered all 49 visible rows even after the
     * rows themselves stopped taking the scope as a prop.
     */
    const setEditing = (request?: EditRequest): void => {
        const scope = activeResourceExplorerScope();
        setEditingState(request && scope ? { request, scopeId: scope.scopeId } : undefined);
    };
    const setSelectedPath = (path?: string): void => setScopeSelectedPath(scopeId, path);
    const requestFocus = (target: FocusTarget): void => {
        const scope = activeResourceExplorerScope();
        if (!scope) return;
        if (target.kind === 'path') {
            setScopeFocusPath(scope.scopeId, target.path);
            return;
        }
        setScopeFocusPath(scope.scopeId, undefined);
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
        isRefreshing,
        isRootPasteDisabled: isRootPasteEmpty || isRootPasteBlocked,
        isRootPasteEmpty,
        isRootPasteBlocked,
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
        refreshFiles: () =>
            refreshResourceExplorer(
                { activeFilePath, scopeId, sessionRootPath },
                {
                    revealPath: didRevealPathInScope,
                    runRefresh: () => {
                        if (refreshCommand) executeCommand(refreshCommand);
                    },
                },
            ),
        requestFocus,
        rootPathCaption: fileTreeRootCaption(session.rootPath),
        scopeId,
        session,
        setEditing,
    };
}
