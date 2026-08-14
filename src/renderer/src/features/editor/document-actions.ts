import {
    editorTabPathsToClose,
    openEditorTabState,
    pinEditorTabState,
    reconcileEditorTabDirtiness,
    updateEditorTabState,
    type EditorTabCloseMode,
} from '@shared/editor-state';
import { isGitDiffTabPath } from '@shared/git-diff';
import type { SessionState } from '@shared/types';
import { activateWorkState, resolveActiveWork, type WorkItem } from '@shared/work-item';

import { caxri } from '../../lib/caxri';
import { pathIsAtOrBelow, remapPath } from '../../lib/file-path';
import {
    getBootstrap,
    getProjectSessionIds,
    getSelectedSession,
    getSessionState,
    getSessionTerminals,
} from '../../stores/selectors';
import { getResolvedActiveWork, useSessionViewStore } from '../../stores/session-view';
import { tryCommand } from '../../stores/toasts';
import { patchSessionState, persistSessionState, useWorkbenchStore } from '../../stores/workbench';
import { markEditorDocumentReady, markEditorOpenStarted } from './editor-performance';

let fileOpenIntent = 0;

const fileName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;

interface PendingDocumentOperation {
    discarded: boolean;
    path: string;
    sessionId: string;
}

/**
 * Reads and writes can finish after a rename, move, or Trash request. Tracking only active work
 * lets file mutations remap or invalidate it without retaining an unbounded path history.
 */
const pendingDocumentOperations = new Set<PendingDocumentOperation>();

function trackDocumentOperation(sessionId: string, path: string): PendingDocumentOperation {
    const operation = { discarded: false, path, sessionId };
    pendingDocumentOperations.add(operation);
    return operation;
}

function remapPendingDocumentOperations(
    sessionId: string,
    previousPath: string,
    nextPath: string,
): void {
    for (const operation of pendingDocumentOperations) {
        if (operation.sessionId === sessionId && pathIsAtOrBelow(operation.path, previousPath))
            operation.path = remapPath(operation.path, previousPath, nextPath);
    }
}

function discardPendingDocumentOperations(sessionId: string, path: string): void {
    for (const operation of pendingDocumentOperations) {
        if (operation.sessionId === sessionId && pathIsAtOrBelow(operation.path, path))
            operation.discarded = true;
    }
}

/** Updates dirtiness and pins a preview as soon as it contains an edit. */
function updateOpenTab(sessionId: string, path: string, dirty: boolean): void {
    const current = useWorkbenchStore
        .getState()
        .bootstrap?.sessionStates.find((state) => state.sessionId === sessionId);
    if (!current) return;
    const next = updateEditorTabState(current, path, dirty);
    if (next !== current) patchSessionState(next);
}

/** Opens a Renderer-owned editor surface whose content has already been loaded or is virtual. */
function openEditorTabForSession(
    sessionId: string,
    path: string,
    options: { preview?: boolean } = {},
): void {
    const bootstrap = getBootstrap();
    const session = bootstrap?.sessions.find((candidate) => candidate.id === sessionId);
    const current = bootstrap?.sessionStates.find((state) => state.sessionId === sessionId);
    if (!session || !current) return;
    const view = useSessionViewStore.getState();
    const previousActiveWork = view.activeWork[session.id];
    const pathWasOpen = current.openTabs.some((tab) => tab.path === path);
    const reconciled = reconcileEditorTabDirtiness(current, view.documents[session.id]);
    const opened = openEditorTabState(reconciled, path, options.preview === true);
    const replacedDocument = opened.replacedPath
        ? view.documents[session.id]?.[opened.replacedPath]
        : undefined;
    if (opened.replacedPath) view.evictDocument(session.id, opened.replacedPath);
    const item: WorkItem = { kind: 'editor', path };
    view.setActiveWork(session.id, item);
    const next = activateWorkState(opened.state, item);
    /** Session persistence rollback must also undo the Renderer-owned half of preview replacement. */
    if (next !== current)
        patchSessionState(next, undefined, () => {
            const currentView = useSessionViewStore.getState();
            if (!pathWasOpen) currentView.evictDocument(session.id, path);
            if (replacedDocument) currentView.cacheDocument(session.id, replacedDocument);
            currentView.setActiveWork(session.id, previousActiveWork);
        });
}

/** Opens an editor tab in the currently selected Session. */
export function openEditorTab(path: string, options: { preview?: boolean } = {}): void {
    const session = getSelectedSession();
    if (!session) return;
    openEditorTabForSession(session.id, path, options);
}

/** Reads a file into the Session document cache without changing the focused WorkItem. */
export async function cacheDocument(sessionId: string, path: string): Promise<void> {
    const operation = trackDocumentOperation(sessionId, path);
    try {
        await tryCommand('Unable to restore file', async () => {
            const document = await caxri.request('files.read', { sessionId, path });
            if (!operation.discarded)
                useSessionViewStore.getState().cacheDocument(sessionId, {
                    ...document,
                    path: operation.path,
                    dirty: false,
                });
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

/** Opens a Host-routed target against its exact Session rather than the transient selected Session. */
export async function openFileForSession(
    sessionId: string,
    path: string,
    options: { preview?: boolean } = {},
): Promise<string | false> {
    const session = getBootstrap()?.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return false;
    const intent = ++fileOpenIntent;
    const operation = trackDocumentOperation(session.id, path);
    markEditorOpenStarted();
    try {
        const opened = await tryCommand('Unable to open file', async () => {
            const document = await caxri.request('files.read', { sessionId: session.id, path });
            if (
                operation.discarded ||
                intent !== fileOpenIntent ||
                !getBootstrap()?.sessions.some((candidate) => candidate.id === session.id)
            )
                return false;
            markEditorDocumentReady();
            const currentPath = operation.path;
            useSessionViewStore.getState().cacheDocument(session.id, {
                ...document,
                path: currentPath,
                dirty: false,
            });
            openEditorTabForSession(session.id, currentPath, options);
            return currentPath;
        });
        return opened ?? false;
    } finally {
        pendingDocumentOperations.delete(operation);
    }
}

/** Selecting an already open tab reuses the cached buffer; an evicted one is read again. */
export function selectEditorTab(path: string): void {
    const session = getSelectedSession();
    if (!session) return;
    if (isGitDiffTabPath(path) || useSessionViewStore.getState().documents[session.id]?.[path])
        useSessionViewStore.getState().activateWork({ kind: 'editor', path });
    else void openFile(path);
}

export function changeDocument(path: string, content: string): void {
    const session = getSelectedSession();
    if (!session) return;
    useSessionViewStore.getState().updateDocumentContent(session.id, path, content);
    updateOpenTab(session.id, path, true);
}

export function pinEditorTab(path: string): void {
    const current = getSessionState();
    if (!current) return;
    const next = pinEditorTabState(current, path);
    if (next !== current) patchSessionState(next);
}

/** Writes one document's current content to disk; returns false only when the write itself failed. */
async function saveDocumentAt(sessionId: string, path: string): Promise<boolean> {
    const document = useSessionViewStore.getState().documents[sessionId]?.[path];
    if (!document) return true;
    const operation = trackDocumentOperation(sessionId, path);
    let saved = false;
    try {
        await tryCommand('Save failed', async () => {
            const result = await caxri.request('files.write', {
                sessionId,
                path,
                content: document.content,
            });
            if (!operation.discarded) {
                const current =
                    useSessionViewStore.getState().documents[sessionId]?.[operation.path];
                if (current) {
                    const changedDuringSave = current.content !== document.content;
                    useSessionViewStore.getState().cacheDocument(sessionId, {
                        ...result,
                        path: operation.path,
                        content: changedDuringSave ? current.content : result.content,
                        dirty: changedDuringSave,
                    });
                    updateOpenTab(sessionId, operation.path, changedDuringSave);
                }
            }
            saved = true;
        });
    } finally {
        pendingDocumentOperations.delete(operation);
    }
    return saved;
}

export async function saveActiveEditor(): Promise<void> {
    const session = getSelectedSession();
    const active = getResolvedActiveWork();
    if (!session || active?.kind !== 'editor') return;
    const path = active.path;
    if (isGitDiffTabPath(path)) return;
    await saveDocumentAt(session.id, path);
}

/**
 * Confirms discarding unsaved changes for each dirty tab about to close, one native "Do you want to
 * save…" sheet at a time (macOS only ever shows one modal sheet). Choosing Cancel on any of them
 * aborts the whole close — a bulk Close Others/Close All must never end up half applied, silently
 * dropping some dirty buffers while leaving others open.
 */
async function confirmDirtyEditorCloses(
    sessionId: string,
    openTabs: SessionState['openTabs'],
    paths: readonly string[],
): Promise<boolean> {
    const dirtyPaths = paths.filter((path) => openTabs.find((tab) => tab.path === path)?.dirty);
    for (const path of dirtyPaths) {
        const { choice } = await caxri.request('editor.confirmDiscard', { name: fileName(path) });
        if (choice === 'cancel') return false;
        if (choice === 'save') await saveDocumentAt(sessionId, path);
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
     * Reuses `activateWorkState` rather than `activateWork` so the openTabs removal and the fallback
     * selection persist atomically instead of as two IPC round trips.
     */
    patchSessionState(
        nextItem
            ? activateWorkState({ ...current, openTabs }, nextItem)
            : { ...current, openTabs, activeTab: undefined },
    );
}

/**
 * Closing a dirty tab must never silently destroy work: every dirty path about to close is
 * confirmed (Save/Don't Save/Cancel) before anything is evicted. The tab list is re-read after the
 * confirmation round trip in case a concurrent operation (rename, Trash) changed it meanwhile.
 */
async function closeEditors(targetPath: string, mode: EditorTabCloseMode): Promise<void> {
    const session = getSelectedSession();
    const initial = getSessionState();
    if (!session || !initial) return;
    const paths = editorTabPathsToClose(initial.openTabs, targetPath, mode);
    if (paths.length === 0) return;
    if (!(await confirmDirtyEditorCloses(session.id, initial.openTabs, paths))) return;
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
    previousPath: string,
    nextPath: string,
    durable = false,
    operationId?: string,
): Promise<boolean> | undefined {
    const bootstrap = useWorkbenchStore.getState().bootstrap;
    const current = bootstrap?.sessionStates.find((state) => state.sessionId === sessionId);
    if (durable && operationId && current?.editorRemapOperationId === operationId)
        return persistSessionState(current, {
            failureLabel: 'Moved editor state could not be saved',
            reportFailure: false,
            retainOnFailure: true,
        });
    remapPendingDocumentOperations(sessionId, previousPath, nextPath);
    if (!current || previousPath === nextPath) return durable ? Promise.resolve(true) : undefined;
    const remapEditorPath = (path: string): string =>
        isGitDiffTabPath(path) ? path : remapPath(path, previousPath, nextPath);
    const openTabs = current.openTabs.map((tab) => ({
        ...tab,
        path: remapEditorPath(tab.path),
    }));
    const activeTab =
        current.activeTab?.kind === 'editor'
            ? { kind: 'editor' as const, path: remapEditorPath(current.activeTab.path) }
            : current.activeTab;
    const activeWork = useSessionViewStore.getState().activeWork[sessionId];
    useSessionViewStore.getState().remapDocuments(sessionId, previousPath, nextPath);
    if (activeWork?.kind === 'editor')
        useSessionViewStore.getState().setActiveWork(sessionId, {
            kind: 'editor',
            path: remapEditorPath(activeWork.path),
        });
    const nextState = {
        ...current,
        openTabs,
        activeTab,
        ...(operationId ? { editorRemapOperationId: operationId } : {}),
    };
    const failureLabel = 'Moved editor state could not be saved';
    if (durable)
        return persistSessionState(nextState, {
            failureLabel,
            reportFailure: false,
            retainOnFailure: true,
        });
    patchSessionState(nextState, failureLabel);
    return undefined;
}

/** Keeps every same-Project Session's normal tabs and dirty buffers attached after a move. */
export function remapOpenEditors(sessionId: string, previousPath: string, nextPath: string): void {
    for (const projectSessionId of getProjectSessionIds(sessionId))
        void remapOpenEditorsInSession(projectSessionId, previousPath, nextPath);
}

/** Persists every same-Project editor remap before a durable file operation is acknowledged. */
export async function remapOpenEditorsDurably(
    sessionId: string,
    operationId: string,
    previousPath: string,
    nextPath: string,
): Promise<void> {
    const saved = await Promise.all(
        getProjectSessionIds(sessionId).map(
            (projectSessionId) =>
                remapOpenEditorsInSession(
                    projectSessionId,
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
        !isGitDiffTabPath(tab.path) && pathIsAtOrBelow(tab.path, path) ? [tab.path] : [],
    );
    if (closingPaths.length === 0) return;
    const closing = new Set(closingPaths);
    const firstClosingIndex = current.openTabs.findIndex((tab) => closing.has(tab.path));
    const openTabs = current.openTabs.filter((tab) => !closing.has(tab.path));
    const sessionTerminals =
        bootstrap?.terminals.filter((terminal) => terminal.sessionId === sessionId) ?? [];
    const resolvedActive = resolveActiveWork({
        activeWork: useSessionViewStore.getState().activeWork[sessionId],
        sessionState: current,
        sessionTerminals,
    });
    const activeWasClosed =
        (resolvedActive?.kind === 'editor' && closing.has(resolvedActive.path)) ||
        (current.activeTab?.kind === 'editor' && closing.has(current.activeTab.path));
    useSessionViewStore.getState().evictDocumentsUnderPath(sessionId, path);
    if (!activeWasClosed) {
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

/** Closes matching normal editors in every same-Project Session after Main confirms Trash. */
export function closeOpenEditorsUnderPath(sessionId: string, path: string): void {
    for (const projectSessionId of getProjectSessionIds(sessionId))
        closeOpenEditorsUnderPathInSession(projectSessionId, path);
}

/**
 * True when a file at or below `path` is open with unsaved edits in any same-Project Session. Lets
 * a Trash confirmation stop promising full recoverability when it would actually discard a dirty
 * buffer that was never written to disk.
 */
export function hasUnsavedChangesUnderPath(sessionId: string, path: string): boolean {
    const bootstrap = useWorkbenchStore.getState().bootstrap;
    return getProjectSessionIds(sessionId).some((projectSessionId) => {
        const state = bootstrap?.sessionStates.find((item) => item.sessionId === projectSessionId);
        return state?.openTabs.some(
            (tab) => !isGitDiffTabPath(tab.path) && tab.dirty && pathIsAtOrBelow(tab.path, path),
        );
    });
}
