import type {
    EditorNavigationTarget,
    PaneLayout,
    PaneTabCloseMode,
    SessionState,
} from '@caxri/protocol';
import {
    closeTabs,
    findResourceTabs,
    findTab,
    isVirtualEditorTabPath,
    listPaneTabs,
    openResource,
    paneTabIdsToClose,
    pinPaneTab,
    remapPaneLayoutPaths,
} from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';
import { editorModelPath } from '@desktop-shared/editor-state';

import { caxri } from '../../lib/caxri';
import { isPathAtOrBelow, remapPath } from '../../lib/file-path';
import {
    getBootstrap,
    getProjectSessionIds,
    getSelectedSession,
    getSessionProjectId,
    getSessionState,
} from '../../stores/selectors';
import {
    getSessionDocuments,
    sessionViewScope,
    useSessionViewStore,
} from '../../stores/session-view';
import { tryCommand } from '../../stores/toasts';
import { patchSessionState, persistSessionState, useWorkbenchStore } from '../../stores/workbench';
import { closeTerminal } from '../terminal/terminal-actions';
import { getActivePaneTab, getPaneLayout } from '../workbench/pane-actions';
import { markEditorDocumentReady, markEditorOpenStarted } from './editor-performance';
import { queueEditorNavigation, revealEditorNavigation } from './editor-reveal';

const fileOpenIntentState = { current: 0 };

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

function sessionStateOf(sessionId: string): SessionState | undefined {
    return useWorkbenchStore
        .getState()
        .bootstrap?.sessionStates.find((state) => state.sessionId === sessionId);
}

/**
 * Every document path currently occupying a tab in the given layout, in tree order. Repeated because the same document
 * may be open in several panes.
 */
function layoutDocumentPaths(layout: PaneLayout): string[] {
    return listPaneTabs(layout).flatMap(({ tab }) =>
        tab.resource.kind === 'file' ? [tab.resource.path] : [],
    );
}

function isDocumentDirty(sessionId: string, path: string, workbenchProjectId?: string): boolean {
    return getSessionDocuments(sessionId, workbenchProjectId)?.[path]?.dirty === true;
}

/**
 * Opens a Renderer-owned editor surface whose content has already been loaded or is virtual.
 */
function openEditorTabForSession(
    sessionId: string,
    path: string,
    options: {
        location?: EditorNavigationTarget;
        paneId?: string;
        preview?: boolean;
    } = {},
): void {
    const current = sessionStateOf(sessionId);
    if (!current) return;
    const workbenchProjectId = current.workbenchProjectId;
    const view = useSessionViewStore.getState();
    const existing = findResourceTabs(current.paneLayout, { kind: 'file', path });
    const wasOpen = existing.length > 0;
    const wasMounted = existing.some(({ pane, tab }) => pane.activeTabId === tab.id);
    const opened = openResource(
        current.paneLayout,
        { kind: 'file', path },
        { paneId: options.paneId, preview: options.preview === true },
    );
    /**
     * Opening into a preview slot replaces whatever preview was there. Its buffer is released in the same update, but
     * only once no other pane still shows that document.
     */
    const surviving = new Set(layoutDocumentPaths(opened));
    const replacedPaths = [
        ...new Set(layoutDocumentPaths(current.paneLayout).filter((path) => !surviving.has(path))),
    ];
    const replacedDocuments = replacedPaths.flatMap((replaced) => {
        const document = getSessionDocuments(sessionId, workbenchProjectId)?.[replaced];
        return document ? [document] : [];
    });
    if (options.location && (wasOpen || opened !== current.paneLayout)) {
        const modelPath = editorModelPath(sessionViewScope(sessionId, workbenchProjectId), path);
        if (wasMounted) revealEditorNavigation(modelPath, options.location);
        else queueEditorNavigation(modelPath, options.location);
    }
    for (const replaced of replacedPaths)
        view.evictDocument(sessionId, replaced, workbenchProjectId);
    view.touchDocument(sessionId, path, workbenchProjectId);
    if (opened === current.paneLayout) return;
    patchSessionState({ ...current, paneLayout: opened }, undefined, () => {
        const currentView = useSessionViewStore.getState();
        if (!wasOpen) currentView.evictDocument(sessionId, path, workbenchProjectId);
        for (const document of replacedDocuments)
            currentView.cacheDocument(sessionId, document, workbenchProjectId);
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
 * Reads a file into the Session document cache without opening a tab for it.
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
    options: { location?: EditorNavigationTarget; preview?: boolean } = {},
): Promise<string | false> {
    const session = getSelectedSession();
    if (!session) return false;
    return openFileForSession(session.id, path, options);
}

/**
 * Opens a Server-routed target against its exact Session rather than the transient selected Session.
 */
export async function openFileForSession(
    sessionId: string,
    path: string,
    options: { location?: EditorNavigationTarget; preview?: boolean } = {},
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

export function changeDocument(path: string, content: string): void {
    const session = getSelectedSession();
    if (!session) return;
    useSessionViewStore.getState().updateDocumentContent(session.id, path, content);
    /**
     * An edit pins the preview it was typed into. Only the edited occurrence is pinned: the same document previewed in
     * another pane is a separate tab and keeps its own preview state.
     */
    const layout = getPaneLayout();
    const previewTab = layout
        ? findResourceTabs(layout, { kind: 'file', path }).find(({ tab }) => tab.preview)
        : undefined;
    if (previewTab) pinDocumentTab(previewTab.tab.id);
}

/**
 * Turns a preview tab into a durable one, keyed by the tab occurrence rather than by its path.
 */
export function pinDocumentTab(tabId: string): void {
    const current = getSessionState();
    if (!current) return;
    const next = pinPaneTab(current.paneLayout, tabId);
    if (next !== current.paneLayout) patchSessionState({ ...current, paneLayout: next });
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
    const active = getActivePaneTab();
    if (!session || active?.resource.kind !== 'file') return;
    const path = active.resource.path;
    if (isVirtualEditorTabPath(path)) return;
    await didSaveDocumentAt(session.id, path);
}

/**
 * Confirms discarding unsaved changes for each dirty tab about to close, one native "Do you want to save…" sheet at a
 * time (macOS only ever shows one modal sheet). Choosing Cancel on any of them aborts the whole close — a bulk Close
 * Others/Close All must never end up half applied, silently dropping some dirty buffers while leaving others open.
 *
 * A document open in several panes is only confirmed once, and only when the close would remove its last occurrence:
 * closing one of two views of the same buffer discards nothing.
 */
async function didConfirmDirtyEditorCloses(
    sessionId: string,
    layout: PaneLayout,
    tabIds: readonly string[],
): Promise<boolean> {
    const closing = new Set(tabIds);
    const remaining = new Set(layoutDocumentPaths(closeTabs(layout, [...closing])));
    const dirtyPaths = [
        ...new Set(
            tabIds.flatMap((tabId) => {
                const tab = findTab(layout, tabId)?.tab;
                if (tab?.resource.kind !== 'file') return [];
                const path = tab.resource.path;
                if (remaining.has(path) || isVirtualEditorTabPath(path)) return [];
                return isDocumentDirty(sessionId, path) ? [path] : [];
            }),
        ),
    ];
    for (const path of dirtyPaths) {
        // Intentionally sequential: macOS only ever shows one modal "Do you want to save…" sheet, so
        // each confirmation must resolve before the next one is requested.
        // eslint-disable-next-line no-await-in-loop -- intentional sequential await, see comment above
        const { choice } = await caxri.request('editor.confirmDiscard', {
            name: pathBasename(path),
        });
        if (choice === 'cancel') return false;
        // Intentionally sequential: a bulk close must never end up half applied, so each save
        // completes before the next tab is confirmed.
        // eslint-disable-next-line no-await-in-loop -- intentional sequential await, see comment above
        if (choice === 'save') await didSaveDocumentAt(sessionId, path);
    }
    return true;
}

/**
 * Closes a pane-local family of tabs (Close, Close Others, Close to the Right, Close All) regardless of what each tab
 * holds — the family is resolved against the pane, never against one kind. A dirty document is confirmed (Save/Don't
 * Save/Cancel) before anything is evicted, and the layout is re-read after that round trip in case a concurrent
 * operation (rename, Trash) changed it meanwhile. A Terminal among the closed tabs must give up its PTY through the
 * Server lifecycle in the same pass — merely dropping its tab from the layout would leave the process running with
 * nothing left to show or close it.
 */
export async function closeDocumentTabs(tabIds: readonly string[]): Promise<void> {
    const session = getSelectedSession();
    const initial = getSessionState();
    if (!session || !initial || tabIds.length === 0) return;
    if (!(await didConfirmDirtyEditorCloses(session.id, initial.paneLayout, tabIds))) return;
    const current = getSessionState();
    if (!current) return;
    const remaining = tabIds.flatMap((tabId) => {
        const found = findTab(current.paneLayout, tabId);
        return found ? [found.tab] : [];
    });
    if (remaining.length === 0) return;
    const remainingIds = remaining.map((tab) => tab.id);
    const next = closeTabs(current.paneLayout, remainingIds);
    const survivingPaths = new Set(layoutDocumentPaths(next));
    for (const path of layoutDocumentPaths(current.paneLayout))
        if (!survivingPaths.has(path))
            useSessionViewStore.getState().evictDocument(session.id, path);
    patchSessionState({ ...current, paneLayout: next });
    for (const tab of remaining)
        if (tab.resource.kind === 'terminal') closeTerminal(tab.resource.terminalId);
}

/**
 * Pane-local close families (Close, Close Others, Close to the Right, Close All), resolved against the tab's own pane.
 */
export function closeDocumentTabFamily(tabId: string, mode: PaneTabCloseMode): Promise<void> {
    const layout = getPaneLayout();
    return layout ? closeDocumentTabs(paneTabIdsToClose(layout, tabId, mode)) : Promise.resolve();
}

function remapOpenEditorsInSession(
    sessionId: string,
    workbenchProjectId: string,
    previousPath: string,
    nextPath: string,
    isDurable = false,
    operationId?: string,
): Promise<boolean> | undefined {
    const current = sessionStateOf(sessionId);
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
    useSessionViewStore
        .getState()
        .remapDocuments(sessionId, previousPath, nextPath, workbenchProjectId);
    if (!current || !isRootIsCurrent) return isDurable ? Promise.resolve(true) : undefined;
    const nextState = {
        ...current,
        paneLayout: remapPaneLayoutPaths(current.paneLayout, (path) =>
            isVirtualEditorTabPath(path) ? path : remapPath(path, previousPath, nextPath),
        ),
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
 * Remaps transient state for the originating root; Server acknowledgement owns inactive storage.
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
    const current = sessionStateOf(sessionId);
    if (!current) return;
    const closingIds = listPaneTabs(current.paneLayout).flatMap(({ tab }) =>
        tab.resource.kind === 'file' &&
        !isVirtualEditorTabPath(tab.resource.path) &&
        isPathAtOrBelow(tab.resource.path, path)
            ? [tab.id]
            : [],
    );
    if (closingIds.length === 0) return;
    useSessionViewStore.getState().evictDocumentsUnderPath(sessionId, path);
    patchSessionState(
        { ...current, paneLayout: closeTabs(current.paneLayout, closingIds) },
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
    return getProjectSessionIds(sessionId).some((projectSessionId) => {
        const state = sessionStateOf(projectSessionId);
        if (!state) return false;
        return layoutDocumentPaths(state.paneLayout).some(
            (candidate) =>
                !isVirtualEditorTabPath(candidate) &&
                isPathAtOrBelow(candidate, path) &&
                isDocumentDirty(projectSessionId, candidate, state.workbenchProjectId),
        );
    });
}
