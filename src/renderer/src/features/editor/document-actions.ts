import type { EditorTabCloseMode } from '@shared/editor-state';
import {
    editorTabPathsToClose,
    openEditorTabState,
    pinEditorTabState,
    reconcileEditorTabDirtiness,
    updateEditorTabState,
} from '@shared/editor-state';
import { isGitDiffTabPath } from '@shared/git-diff';
import type { SessionState } from '@shared/types';
import type { WorkItem } from '@shared/work-item';
import { activateWorkState, resolveActiveWork } from '@shared/work-item';

import { caxri } from '../../lib/caxri';
import { isPathAtOrBelow, remapPath } from '../../lib/file-path';
import {
    getBootstrap,
    getProjectSessionIds,
    getSelectedSession,
    getSessionProjectId,
    getSessionState,
    getSessionTerminals,
} from '../../stores/selectors';
import {
    getResolvedActiveWork,
    getSessionActiveWork,
    getSessionDocuments,
    useSessionViewStore,
} from '../../stores/session-view';
import { tryCommand } from '../../stores/toasts';
import { patchSessionState, persistSessionState, useWorkbenchStore } from '../../stores/workbench';
import { markEditorDocumentReady, markEditorOpenStarted } from './editor-performance';

const fileOpenIntentState = { current: 0 };

const fileName = (path: string): string => path.split('/').findLast(Boolean) ?? path;

interface PendingDocumentOperation {
    discarded: boolean;
    path: string;
    sessionId: string;
    workbenchProjectId?: string;
}

/**
 * Reads and writes can finish after a rename, move, or Trash request. Tracking only active work lets file mutations
 * remap or invalidate it without retaining an unbounded path history.
 */
const pendingDocumentOperations = new Set<PendingDocumentOperation>();

function trackDocumentOperation(sessionId: string, path: string): PendingDocumentOperation {
    const workbenchProjectId = getBootstrap()?.sessions.find(
        (session) => session.id === sessionId,
    )?.workbenchProjectId;
    const operation = { discarded: false, path, sessionId, workbenchProjectId };
    pendingDocumentOperations.add(operation);
    return operation;
}

function remapPendingDocumentOperations(
    sessionId: string,
    workbenchProjectId: string,
    previousPath: string,
    nextPath: string,
): void {
    for (const operation of pendingDocumentOperations) {
        if (
            operation.sessionId === sessionId &&
            operation.workbenchProjectId === workbenchProjectId &&
            isPathAtOrBelow(operation.path, previousPath)
        )
            operation.path = remapPath(operation.path, previousPath, nextPath);
    }
}

function discardPendingDocumentOperations(sessionId: string, path: string): void {
    for (const operation of pendingDocumentOperations) {
        if (operation.sessionId === sessionId && isPathAtOrBelow(operation.path, path))
            operation.discarded = true;
    }
}

/**
 * Updates dirtiness and pins a preview as soon as it contains an edit.
 */
function updateOpenTab(
    sessionId: string,
    path: string,
    isDirty: boolean,
    workbenchProjectId?: string,
): void {
    const current = useWorkbenchStore
        .getState()
        .bootstrap?.sessionStates.find(
            (state) =>
                state.sessionId === sessionId &&
                (!workbenchProjectId || state.workbenchProjectId === workbenchProjectId),
        );
    if (!current) return;
    const next = updateEditorTabState(current, path, isDirty);
    if (next !== current) patchSessionState(next);
}

/**
 * Opens a Renderer-owned editor surface whose content has already been loaded or is virtual.
 */
function openEditorTabForSession(
    sessionId: string,
    path: string,
    options: { preview?: boolean } = {},
): void {
    const bootstrap = getBootstrap();
    const session = bootstrap?.sessions.find((candidate) => candidate.id === sessionId);
    const current = bootstrap?.sessionStates.find((state) => state.sessionId === sessionId);
    if (!session || !current) return;
    const workbenchProjectId = current.workbenchProjectId;
    const view = useSessionViewStore.getState();
    const previousActiveWork = getSessionActiveWork(session.id, workbenchProjectId);
    const isPathWasOpen = current.openTabs.some((tab) => tab.path === path);
    const reconciled = reconcileEditorTabDirtiness(
        current,
        getSessionDocuments(session.id, workbenchProjectId),
    );
    const opened = openEditorTabState(reconciled, path, options.preview === true);
    const replacedDocument = opened.replacedPath
        ? getSessionDocuments(session.id, workbenchProjectId)?.[opened.replacedPath]
        : undefined;
    if (opened.replacedPath)
        view.evictDocument(session.id, opened.replacedPath, workbenchProjectId);
    const item: WorkItem = { kind: 'editor', path };
    view.setActiveWork(session.id, item, workbenchProjectId);
    const next = activateWorkState(opened.state, item);
    /**
     * Session persistence rollback must also undo the Renderer-owned half of preview replacement.
     */
    if (next !== current)
        patchSessionState(next, undefined, () => {
            const currentView = useSessionViewStore.getState();
            if (!isPathWasOpen) currentView.evictDocument(session.id, path, workbenchProjectId);
            if (replacedDocument)
                currentView.cacheDocument(session.id, replacedDocument, workbenchProjectId);
            currentView.setActiveWork(session.id, previousActiveWork, workbenchProjectId);
        });
}

/**
 * Opens an editor tab in the currently selected Session.
 */
export function openEditorTab(path: string, options: { preview?: boolean } = {}): void {
    const session = getSelectedSession();
    if (!session) return;
    openEditorTabForSession(session.id, path, options);
}

/**
 * Reads a file into the Session document cache without changing the focused WorkItem.
 */
export async function cacheDocument(sessionId: string, path: string): Promise<void> {
    const operation = trackDocumentOperation(sessionId, path);
    try {
        await tryCommand('Unable to restore file', async () => {
            const document = await caxri.request('files.read', { sessionId, path });
            if (!operation.discarded)
                useSessionViewStore.getState().cacheDocument(
                    sessionId,
                    {
                        ...document,
                        path: operation.path,
                        dirty: false,
                    },
                    operation.workbenchProjectId,
                );
        });
    } finally {
        pendingDocumentOperations.delete(operation);
    }
}

export async function openFile(
    path: string,
    options: { preview?: boolean } = {},
): Promise<string | false> {
    const session = getSelectedSession();
    if (!session) return false;
    return openFileForSession(session.id, path, options);
}

/**
 * Opens a Host-routed target against its exact Session rather than the transient selected Session.
 */
export async function openFileForSession(
    sessionId: string,
    path: string,
    options: { preview?: boolean } = {},
): Promise<string | false> {
    const session = getBootstrap()?.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return false;
    fileOpenIntentState.current += 1;
    const intent = fileOpenIntentState.current;
    const operation = trackDocumentOperation(session.id, path);
    markEditorOpenStarted();
    try {
        const opened = await tryCommand('Unable to open file', async () => {
            const document = await caxri.request('files.read', { sessionId: session.id, path });
            if (
                intent !== fileOpenIntentState.current ||
                operation.discarded ||
                !getBootstrap()?.sessions.some((candidate) => candidate.id === session.id) ||
                getBootstrap()?.sessions.find((candidate) => candidate.id === session.id)
                    ?.workbenchProjectId !== operation.workbenchProjectId
            )
                return false;
            markEditorDocumentReady();
            const currentPath = operation.path;
            useSessionViewStore.getState().cacheDocument(
                session.id,
                {
                    ...document,
                    path: currentPath,
                    dirty: false,
                },
                operation.workbenchProjectId,
            );
            openEditorTabForSession(session.id, currentPath, options);
            return currentPath;
        });
        return opened ?? false;
    } finally {
        pendingDocumentOperations.delete(operation);
    }
}

/**
 * Selecting an already open tab reuses the cached buffer; an evicted one is read again.
 */
export function selectEditorTab(path: string): void {
    const session = getSelectedSession();
    if (!session) return;
    const documents = getSessionDocuments(session.id);
    if (isGitDiffTabPath(path) || (documents && Object.hasOwn(documents, path)))
        useSessionViewStore.getState().activateWork({ kind: 'editor', path });
    else {
        // Fire-and-forget: `openFile` funnels its own failures into a toast via `tryCommand`, so
        // there is nothing left for this handler to await or react to.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void openFile(path);
    }
}

export function changeDocument(path: string, content: string): void {
    const session = getSelectedSession();
    if (!session) return;
    useSessionViewStore.getState().updateDocumentContent(session.id, path, content);
    updateOpenTab(session.id, path, true, session.workbenchProjectId);
}

export function pinEditorTab(path: string): void {
    const current = getSessionState();
    if (!current) return;
    const next = pinEditorTabState(current, path);
    if (next !== current) patchSessionState(next);
}

/**
 * Writes one document's current content to disk; returns false only when the write itself failed.
 */
async function didSaveDocumentAt(sessionId: string, path: string): Promise<boolean> {
    const document = getSessionDocuments(sessionId)?.[path];
    if (!document) return true;
    const operation = trackDocumentOperation(sessionId, path);
    let isSaved = false;
    try {
        await tryCommand('Save failed', async () => {
            const result = await caxri.request('files.write', {
                sessionId,
                path,
                content: document.content,
            });
            if (!operation.discarded) {
                const current = getSessionDocuments(sessionId, operation.workbenchProjectId)?.[
                    operation.path
                ];
                if (current) {
                    const isChangedDuringSave = current.content !== document.content;
                    useSessionViewStore.getState().cacheDocument(
                        sessionId,
                        {
                            ...result,
                            path: operation.path,
                            content: isChangedDuringSave ? current.content : result.content,
                            dirty: isChangedDuringSave,
                        },
                        operation.workbenchProjectId,
                    );
                    updateOpenTab(
                        sessionId,
                        operation.path,
                        isChangedDuringSave,
                        operation.workbenchProjectId,
                    );
                }
            }
            isSaved = true;
        });
    } finally {
        pendingDocumentOperations.delete(operation);
    }
    return isSaved;
}

export async function saveActiveEditor(): Promise<void> {
    const session = getSelectedSession();
    const active = getResolvedActiveWork();
    if (!session || active?.kind !== 'editor') return;
    const path = active.path;
    if (isGitDiffTabPath(path)) return;
    await didSaveDocumentAt(session.id, path);
}

/**
 * Confirms discarding unsaved changes for each dirty tab about to close, one native "Do you want to save…" sheet at a
 * time (macOS only ever shows one modal sheet). Choosing Cancel on any of them aborts the whole close — a bulk Close
 * Others/Close All must never end up half applied, silently dropping some dirty buffers while leaving others open.
 */
async function didConfirmDirtyEditorCloses(
    sessionId: string,
    openTabs: SessionState['openTabs'],
    paths: readonly string[],
): Promise<boolean> {
    const dirtyPaths = paths.filter((path) => openTabs.find((tab) => tab.path === path)?.dirty);
    for (const path of dirtyPaths) {
        // Intentionally sequential: macOS only ever shows one modal "Do you want to save…" sheet, so
        // each confirmation must resolve before the next one is requested.
        // eslint-disable-next-line no-await-in-loop -- intentional sequential await, see comment above
        const { choice } = await caxri.request('editor.confirmDiscard', { name: fileName(path) });
        if (choice === 'cancel') return false;
        // Intentionally sequential: a bulk close must never end up half applied, so each save
        // completes before the next tab is confirmed.
        // eslint-disable-next-line no-await-in-loop -- intentional sequential await, see comment above
        if (choice === 'save') await didSaveDocumentAt(sessionId, path);
    }
    return true;
}

function applyEditorTabClose(
    session: { id: string },
    current: SessionState,
    paths: readonly string[],
    targetPath: string,
): void {
    const closing = new Set(paths);
    for (const path of paths) useSessionViewStore.getState().evictDocument(session.id, path);
    const openTabs = current.openTabs.filter((tab) => !closing.has(tab.path));
    const wasActive = current.activeTab?.kind === 'editor' && closing.has(current.activeTab.path);
    if (!wasActive) {
        patchSessionState({ ...current, openTabs });
        return;
    }
    const targetIndex = current.openTabs.findIndex((tab) => tab.path === targetPath);
    const fallbackPath =
        openTabs.find((tab) => tab.path === targetPath)?.path ??
        openTabs[Math.min(Math.max(targetIndex, 0), openTabs.length - 1)]?.path;
    const sessionTerminals = getSessionTerminals();
    const nextItem: WorkItem | undefined = fallbackPath
        ? { kind: 'editor', path: fallbackPath }
        : sessionTerminals[0]
          ? { kind: 'terminal', terminalId: sessionTerminals[0].id }
          : undefined;
    useSessionViewStore.getState().setActiveWork(session.id, nextItem);
    /**
     * Reuses `activateWorkState` rather than `activateWork` so the openTabs removal and the fallback selection persist
     * atomically instead of as two IPC round trips.
     */
    patchSessionState(
        nextItem
            ? activateWorkState({ ...current, openTabs }, nextItem)
            : { ...current, openTabs, activeTab: undefined },
    );
}

/**
 * Closing a dirty tab must never silently destroy work: every dirty path about to close is confirmed (Save/Don't
 * Save/Cancel) before anything is evicted. The tab list is re-read after the confirmation round trip in case a
 * concurrent operation (rename, Trash) changed it meanwhile.
 */
async function closeEditors(targetPath: string, mode: EditorTabCloseMode): Promise<void> {
    const session = getSelectedSession();
    const initial = getSessionState();
    if (!session || !initial) return;
    const paths = editorTabPathsToClose(initial.openTabs, targetPath, mode);
    if (paths.length === 0) return;
    if (!(await didConfirmDirtyEditorCloses(session.id, initial.openTabs, paths))) return;
    const current = getSessionState();
    if (!current) return;
    const remainingPaths = paths.filter((path) =>
        current.openTabs.some((tab) => tab.path === path),
    );
    if (remainingPaths.length === 0) return;
    applyEditorTabClose(session, current, remainingPaths, targetPath);
}

export function closeEditor(path: string): Promise<void> {
    return closeEditors(path, 'one');
}

export function closeOtherEditors(path: string): Promise<void> {
    return closeEditors(path, 'others');
}

export function closeEditorsToRight(path: string): Promise<void> {
    return closeEditors(path, 'right');
}

export function closeAllEditors(path: string): Promise<void> {
    return closeEditors(path, 'all');
}

function remapOpenEditorsInSession(
    sessionId: string,
    workbenchProjectId: string,
    previousPath: string,
    nextPath: string,
    isDurable = false,
    operationId?: string,
): Promise<boolean> | undefined {
    const bootstrap = useWorkbenchStore.getState().bootstrap;
    const current = bootstrap?.sessionStates.find((state) => state.sessionId === sessionId);
    const isRootIsCurrent = current?.workbenchProjectId === workbenchProjectId;
    if (
        isDurable &&
        operationId &&
        isRootIsCurrent &&
        current.editorRemapOperationId === operationId
    )
        return persistSessionState(current, {
            failureLabel: 'Moved editor state could not be saved',
            reportFailure: false,
            retainOnFailure: true,
        });
    remapPendingDocumentOperations(sessionId, workbenchProjectId, previousPath, nextPath);
    if (previousPath === nextPath) return isDurable ? Promise.resolve(true) : undefined;
    const remapEditorPath = (path: string): string =>
        isGitDiffTabPath(path) ? path : remapPath(path, previousPath, nextPath);
    const activeWork = getSessionActiveWork(sessionId, workbenchProjectId);
    useSessionViewStore
        .getState()
        .remapDocuments(sessionId, previousPath, nextPath, workbenchProjectId);
    if (activeWork?.kind === 'editor')
        useSessionViewStore
            .getState()
            .setActiveWork(
                sessionId,
                { kind: 'editor', path: remapEditorPath(activeWork.path) },
                workbenchProjectId,
            );
    if (!current || !isRootIsCurrent) return isDurable ? Promise.resolve(true) : undefined;
    const openTabs = current.openTabs.map((tab) => ({
        ...tab,
        path: remapEditorPath(tab.path),
    }));
    const activeTab =
        current.activeTab?.kind === 'editor'
            ? { kind: 'editor' as const, path: remapEditorPath(current.activeTab.path) }
            : current.activeTab;
    const nextState = {
        ...current,
        openTabs,
        activeTab,
        ...(operationId && { editorRemapOperationId: operationId }),
    };
    const failureLabel = 'Moved editor state could not be saved';
    if (isDurable)
        return persistSessionState(nextState, {
            failureLabel,
            reportFailure: false,
            retainOnFailure: true,
        });
    patchSessionState(nextState, failureLabel);
    return undefined;
}

/**
 * Keeps every same-Project Session's normal tabs and dirty buffers attached after a move.
 */
export function remapOpenEditors(sessionId: string, previousPath: string, nextPath: string): void {
    const workbenchProjectId = getSessionProjectId(sessionId);
    if (!workbenchProjectId) return;
    for (const projectSessionId of getProjectSessionIds(sessionId))
        // Fire-and-forget: the non-durable remap only touches in-memory Renderer state and never
        // rejects, so there is nothing for this loop to await or react to.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void remapOpenEditorsInSession(
            projectSessionId,
            workbenchProjectId,
            previousPath,
            nextPath,
        );
}

/**
 * Remaps transient state for the originating root; Runtime acknowledgement owns inactive storage.
 */
export async function remapOpenEditorsDurably(
    sessionId: string,
    workbenchProjectId: string,
    operationId: string,
    previousPath: string,
    nextPath: string,
): Promise<void> {
    const saved = await Promise.all(
        (getBootstrap()?.sessions.map((session) => session.id) ?? [sessionId]).map(
            (projectSessionId) =>
                remapOpenEditorsInSession(
                    projectSessionId,
                    workbenchProjectId,
                    previousPath,
                    nextPath,
                    true,
                    operationId,
                ) ?? Promise.resolve(true),
        ),
    );
    if (saved.some((result) => !result)) throw new Error('Moved editor state could not be saved');
}

function closeOpenEditorsUnderPathInSession(sessionId: string, path: string): void {
    discardPendingDocumentOperations(sessionId, path);
    const bootstrap = useWorkbenchStore.getState().bootstrap;
    const current = bootstrap?.sessionStates.find((state) => state.sessionId === sessionId);
    if (!current) return;
    const closingPaths = current.openTabs.flatMap((tab) =>
        !isGitDiffTabPath(tab.path) && isPathAtOrBelow(tab.path, path) ? [tab.path] : [],
    );
    if (closingPaths.length === 0) return;
    const closing = new Set(closingPaths);
    const firstClosingIndex = current.openTabs.findIndex((tab) => closing.has(tab.path));
    const openTabs = current.openTabs.filter((tab) => !closing.has(tab.path));
    const sessionTerminals =
        bootstrap?.terminals.filter((terminal) => terminal.sessionId === sessionId) ?? [];
    const resolvedActive = resolveActiveWork({
        activeWork: getSessionActiveWork(sessionId),
        sessionState: current,
        sessionTerminals,
    });
    const isActiveWasClosed =
        (resolvedActive?.kind === 'editor' && closing.has(resolvedActive.path)) ||
        (current.activeTab?.kind === 'editor' && closing.has(current.activeTab.path));
    useSessionViewStore.getState().evictDocumentsUnderPath(sessionId, path);
    if (!isActiveWasClosed) {
        patchSessionState({ ...current, openTabs });
        return;
    }
    const fallbackPath = openTabs[Math.min(firstClosingIndex, openTabs.length - 1)]?.path;
    const terminal = sessionTerminals[0];
    const nextItem: WorkItem | undefined = fallbackPath
        ? { kind: 'editor', path: fallbackPath }
        : terminal
          ? { kind: 'terminal', terminalId: terminal.id }
          : undefined;
    useSessionViewStore.getState().setActiveWork(sessionId, nextItem);
    patchSessionState(
        nextItem
            ? activateWorkState({ ...current, openTabs }, nextItem)
            : { ...current, openTabs, activeTab: undefined },
        'Trashed editor state could not be saved',
    );
}

/**
 * Closes matching normal editors in every same-Project Session after Main confirms Trash.
 */
export function closeOpenEditorsUnderPath(sessionId: string, path: string): void {
    for (const projectSessionId of getProjectSessionIds(sessionId))
        closeOpenEditorsUnderPathInSession(projectSessionId, path);
}

/**
 * True when a file at or below `path` is open with unsaved edits in any same-Project Session. Lets a Trash confirmation
 * stop promising full recoverability when it would actually discard a dirty buffer that was never written to disk.
 */
export function hasUnsavedChangesUnderPath(sessionId: string, path: string): boolean {
    const bootstrap = useWorkbenchStore.getState().bootstrap;
    return getProjectSessionIds(sessionId).some((projectSessionId) => {
        const state = bootstrap?.sessionStates.find((item) => item.sessionId === projectSessionId);
        return state?.openTabs.some(
            (tab) => !isGitDiffTabPath(tab.path) && tab.dirty && isPathAtOrBelow(tab.path, path),
        );
    });
}
