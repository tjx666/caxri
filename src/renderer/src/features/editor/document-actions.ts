import {
    editorTabPathsToClose,
    openEditorTabState,
    pinEditorTabState,
    updateEditorTabState,
    type EditorTabCloseMode,
} from '@shared/editor-state';
import { isGitDiffTabPath } from '@shared/git-diff';
import { activateWorkState, resolveActiveWork, type WorkItem } from '@shared/work-item';

import { caxri } from '../../lib/caxri';
import { pathIsAtOrBelow, remapPath } from '../../lib/file-path';
import { getSelectedSession, getSessionState, getSessionTerminals } from '../../stores/selectors';
import { getResolvedActiveWork, useSessionViewStore } from '../../stores/session-view';
import { tryCommand } from '../../stores/toasts';
import { patchSessionState, useWorkbenchStore } from '../../stores/workbench';
import { markEditorDocumentReady, markEditorOpenStarted } from './editor-performance';

let fileOpenIntent = 0;

interface PendingDocumentOperation {
    discarded: boolean;
    path: string;
    sessionId: string;
}

/**
 * File reads and writes can finish after a rename, move, or Trash request. Keeping only active
 * intents lets mutation completion remap or invalidate them without retaining an unbounded path
 * history for the Session.
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
export function openEditorTab(path: string, options: { preview?: boolean } = {}): void {
    const session = getSelectedSession();
    const current = getSessionState();
    if (!session || !current) return;
    const opened = openEditorTabState(current, path, options.preview === true);
    if (opened.replacedPath)
        useSessionViewStore.getState().evictDocument(session.id, opened.replacedPath);
    const item: WorkItem = { kind: 'editor', path };
    useSessionViewStore.getState().setActiveWork(session.id, item);
    const next = activateWorkState(opened.state, item);
    if (next !== current) patchSessionState(next);
}

/** Reads a file into the Session document cache without changing the focused WorkItem. */
export async function cacheDocument(sessionId: string, path: string): Promise<void> {
    const operation = trackDocumentOperation(sessionId, path);
    try {
        await tryCommand('Unable to restore file', async () => {
            const document = await caxri.request('files.read', { sessionId, path });
            if (operation.discarded) return;
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
    const intent = ++fileOpenIntent;
    const operation = trackDocumentOperation(session.id, path);
    markEditorOpenStarted();
    try {
        const opened = await tryCommand('Unable to open file', async () => {
            const document = await caxri.request('files.read', { sessionId: session.id, path });
            if (
                operation.discarded ||
                intent !== fileOpenIntent ||
                getSelectedSession()?.id !== session.id
            )
                return false;
            markEditorDocumentReady();
            const currentPath = operation.path;
            useSessionViewStore.getState().cacheDocument(session.id, {
                ...document,
                path: currentPath,
                dirty: false,
            });
            openEditorTab(currentPath, options);
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

export async function saveActiveEditor(): Promise<void> {
    const session = getSelectedSession();
    const active = getResolvedActiveWork();
    if (!session || active?.kind !== 'editor') return;
    const path = active.path;
    if (isGitDiffTabPath(path)) return;
    const document = useSessionViewStore.getState().documents[session.id]?.[path];
    if (!document) return;
    const operation = trackDocumentOperation(session.id, path);
    try {
        await tryCommand('Save failed', async () => {
            const saved = await caxri.request('files.write', {
                sessionId: session.id,
                path,
                content: document.content,
            });
            if (operation.discarded) return;
            const current = useSessionViewStore.getState().documents[session.id]?.[operation.path];
            if (!current) return;
            const changedDuringSave = current.content !== document.content;
            useSessionViewStore.getState().cacheDocument(session.id, {
                ...saved,
                path: operation.path,
                content: changedDuringSave ? current.content : saved.content,
                dirty: changedDuringSave,
            });
            updateOpenTab(session.id, operation.path, changedDuringSave);
        });
    } finally {
        pendingDocumentOperations.delete(operation);
    }
}

function closeEditors(targetPath: string, mode: EditorTabCloseMode): void {
    const session = getSelectedSession();
    const current = getSessionState();
    if (!session || !current) return;
    const paths = editorTabPathsToClose(current.openTabs, targetPath, mode);
    if (paths.length === 0) return;
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

export function closeEditor(path: string): void {
    closeEditors(path, 'one');
}

export function closeOtherEditors(path: string): void {
    closeEditors(path, 'others');
}

export function closeEditorsToRight(path: string): void {
    closeEditors(path, 'right');
}

export function closeAllEditors(path: string): void {
    closeEditors(path, 'all');
}

/** Keeps normal editor tabs and dirty buffers attached to a file or directory after it moves. */
export function remapOpenEditors(sessionId: string, previousPath: string, nextPath: string): void {
    remapPendingDocumentOperations(sessionId, previousPath, nextPath);
    const bootstrap = useWorkbenchStore.getState().bootstrap;
    const current = bootstrap?.sessionStates.find((state) => state.sessionId === sessionId);
    if (!current || previousPath === nextPath) return;
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
    patchSessionState({ ...current, openTabs, activeTab }, 'Moved editor state could not be saved');
}

/** Closes every normal editor under an item only after Main has moved that item to the Trash. */
export function closeOpenEditorsUnderPath(sessionId: string, path: string): void {
    discardPendingDocumentOperations(sessionId, path);
    const bootstrap = useWorkbenchStore.getState().bootstrap;
    const current = bootstrap?.sessionStates.find((state) => state.sessionId === sessionId);
    if (!current) return;
    const closingPaths = current.openTabs
        .map((tab) => tab.path)
        .filter((tabPath) => !isGitDiffTabPath(tabPath) && pathIsAtOrBelow(tabPath, path));
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
