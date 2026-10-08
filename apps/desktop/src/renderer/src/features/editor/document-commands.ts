import type {
    EditorNavigationTarget,
    FileDocument,
    PaneLayout,
    PaneTabCloseMode,
    SessionState,
} from '@caxri/protocol';
import {
    activePane,
    CaxriError,
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
import type { EditorDocument } from '@desktop-shared/editor-state';
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
import type { ToastActionParameters } from '../../stores/toast-actions';
import { tryCommand } from '../../stores/toasts';
import {
    patchSessionState,
    persistSessionState,
    refreshWorkbench,
    useWorkbenchStore,
} from '../../stores/workbench';
import { closeTerminal } from '../terminal/terminal-commands';
import { getActivePaneTab, getPaneLayout } from '../workbench/pane-actions';
import {
    beginFileOpenIntent,
    isCurrentFileOpenIntent,
    supersedePendingFileOpens,
} from './editor-open-intent';
import { markEditorDocumentReady, markEditorOpenStarted } from './editor-performance';
import { focusEditor, queueEditorNavigation, revealEditorNavigation } from './editor-reveal';
import {
    discardPendingDocumentOperations,
    finishDocumentOperation,
    remapPendingDocumentOperations,
    trackDocumentOperation,
} from './pending-document-operations';

interface OpenFileOptions {
    focus?: boolean;
    location?: EditorNavigationTarget;
    /**
     * Exact split pane that should own preview placement and Editor focus.
     */
    paneId?: string;
    preview?: boolean;
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
 * `openResource`'s write can lose a race against a brand-new Session's own initial Terminal-attach write and come back
 * `CONFLICT` ("stale revision") even though nothing the caller did was wrong: both writes originate from opening this
 * same Session for the first time (see `pickCommanderFileLinkSession` in Main), and the Session's very first
 * `session.updateState` has nothing to rebase against locally. Retrying once against a refreshed snapshot is safe
 * because opening a resource is idempotent: recomputing `openResource` either reveals the tab this retry adds, or
 * discovers the resource is already open from whichever write actually won (issue #1409).
 *
 * Retries only on `onStaleWrite`, never by inferring it from the pane layout: a later command (e.g. a close) can
 * supersede this attempt before it settles, leaving a genuine failure looking just like a lost race, and bails if the
 * Session's Workbench Root changed mid-flight. `paneId` is pinned once by the caller instead of re-resolved on every
 * retry, so a pane switch mid-flight cannot scatter the same file across two panes.
 */
async function persistOpenedEditorTab(
    sessionId: string,
    path: string,
    paneId: string,
    isPreview: boolean,
    next: SessionState,
    wasOpen: boolean,
    replacedDocuments: EditorDocument[],
    retriesLeft: number,
): Promise<void> {
    const workbenchProjectId = next.workbenchProjectId;
    let isStale = false;
    const persisted = await useWorkbenchStore.getState().patchSessionState(
        next,
        undefined,
        () => {
            const currentView = useSessionViewStore.getState();
            if (!wasOpen) currentView.evictDocument(sessionId, path, workbenchProjectId);
            for (const document of replacedDocuments)
                currentView.cacheDocument(sessionId, document, workbenchProjectId);
        },
        undefined,
        true,
        () => {
            isStale = true;
        },
    );
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- isStale is set from the onStaleWrite callback above, across an await
    if (persisted || !isStale || retriesLeft <= 0) return;
    await refreshWorkbench();
    const current = sessionStateOf(sessionId);
    if (!current || current.workbenchProjectId !== workbenchProjectId) return;
    // The pinned pane already shows this file; the write that won the race added it, nothing left to persist.
    const alreadyThere = findResourceTabs(current.paneLayout, { kind: 'file', path }).some(
        (occurrence) => occurrence.pane.id === paneId,
    );
    if (alreadyThere) return;
    const opened = openResource(
        current.paneLayout,
        { kind: 'file', path },
        { paneId, preview: isPreview },
    );
    if (opened === current.paneLayout) return;
    await persistOpenedEditorTab(
        sessionId,
        path,
        paneId,
        isPreview,
        { ...current, paneLayout: opened },
        wasOpen,
        replacedDocuments,
        retriesLeft - 1,
    );
}

/**
 * Opens a Renderer-owned editor surface whose content has already been loaded or is virtual.
 */
export function didOpenEditorTabForSession(
    sessionId: string,
    path: string,
    options: {
        location?: EditorNavigationTarget;
        paneId?: string;
        preview?: boolean;
    } = {},
): boolean {
    const current = sessionStateOf(sessionId);
    if (!current) return false;
    const workbenchProjectId = current.workbenchProjectId;
    const view = useSessionViewStore.getState();
    const existing = findResourceTabs(current.paneLayout, { kind: 'file', path });
    const wasOpen = existing.length > 0;
    const wasMounted = existing.some(({ pane, tab }) => pane.activeTabId === tab.id);
    // Resolved once, the same way `openResource` resolves it internally, so a background retry (see `persistOpenedEditorTab`) can pin this exact pane instead of re-resolving "the active pane" later.
    const paneId = options.paneId ?? activePane(current.paneLayout).id;
    const isPreview = options.preview === true;
    const opened = openResource(
        current.paneLayout,
        { kind: 'file', path },
        { paneId, preview: isPreview },
    );
    const didOpen = wasOpen || opened !== current.paneLayout;
    if (!didOpen) return false;
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
    if (opened === current.paneLayout) return true;
    /**
     * Fire-and-forget: the caller already sees this tab optimistically. Persisting continues in the background,
     * retrying once against a refreshed snapshot on a lost revision race (see `persistOpenedEditorTab`).
     */
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void persistOpenedEditorTab(
        sessionId,
        path,
        paneId,
        isPreview,
        { ...current, paneLayout: opened },
        wasOpen,
        replacedDocuments,
        1,
    );
    return true;
}

/**
 * Opens an editor tab in the currently selected Session.
 *
 * The tab activates synchronously, so it supersedes any file open still awaiting `files.read`: otherwise a Settings
 * shortcut pressed right after a File Explorer click opens Settings, then the late read re-activates the file on top of
 * it.
 */
export function openEditorTab(path: string, options: { preview?: boolean } = {}): void {
    const session = getSelectedSession();
    if (!session) return;
    supersedePendingFileOpens();
    didOpenEditorTabForSession(session.id, path, options);
}

/**
 * Reads a file into the Session document cache without opening a tab for it. Resolves to the rejection when the read
 * fails instead of swallowing it: `tryCommand` still owns the toast, which expires after four seconds, while the editor
 * surface needs the same cause to replace its spinner with a state the user can recover from (issue #979).
 */
export async function cacheDocument(
    sessionId: string,
    path: string,
): Promise<{ error: unknown } | undefined> {
    if (isVirtualEditorTabPath(path)) return undefined;
    const operation = trackDocumentOperation(sessionId, path);
    let failure: { error: unknown } | undefined;
    try {
        // The label matches the sentence the editor surface paints, so one failure is not described two ways.
        await tryCommand("Couldn't open this file", async () => {
            try {
                const document = await caxri.request('files.read', { sessionId, path });
                if (!operation.discarded) {
                    useSessionViewStore.getState().cacheDocument(
                        sessionId,
                        {
                            ...document,
                            path: operation.path,
                            dirty: false,
                        },
                        operation.workbenchProjectId,
                    );
                    /**
                     * Admission is budgeted, and a freshly read document is the newest entry rather than a protected
                     * one, so the very write that admits it can evict it again when the Session already holds more
                     * unsaved work than the cache allows. Reporting success then left the editor on a spinner that
                     * nothing re-triggers, which is the state issue #979 exists to remove.
                     */
                    const cached = getSessionDocuments(sessionId, operation.workbenchProjectId)?.[
                        operation.path
                    ];
                    if (!cached)
                        throw new CaxriError(
                            'CAPACITY',
                            'There is no room left for another open file. Save or close some files, then try again.',
                        );
                }
            } catch (error) {
                // Recorded and rethrown rather than handled here, so `tryCommand` keeps sole ownership of the toast
                // and of the rule that a cancelled request is not a failure worth reporting.
                failure = { error };
                throw error;
            }
        });
    } finally {
        finishDocumentOperation(operation);
    }
    return failure;
}

/**
 * Reads several files at once, dropping the ones that failed. External sync uses it to re-read what a watcher reported
 * as changed, where a path deleted between the notification and the read is an ordinary outcome rather than an error.
 */
export async function readDocuments(
    sessionId: string,
    paths: readonly string[],
): Promise<FileDocument[]> {
    const results = await Promise.allSettled(
        paths.map((path) => caxri.request('files.read', { sessionId, path })),
    );
    return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}

export async function openFile(
    path: string,
    options: OpenFileOptions = {},
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
    options: OpenFileOptions = {},
): Promise<string | false> {
    if (isVirtualEditorTabPath(path)) return false;
    const session = getBootstrap()?.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return false;
    const intent = beginFileOpenIntent();
    const operation = trackDocumentOperation(session.id, path);
    markEditorOpenStarted();
    try {
        const opened = await tryCommand('Unable to open file', async () => {
            const document = await caxri.request('files.read', { sessionId: session.id, path });
            if (
                !isCurrentFileOpenIntent(intent) ||
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
            const didOpen = didOpenEditorTabForSession(session.id, currentPath, options);
            if (didOpen && options.focus)
                focusEditor(
                    editorModelPath(
                        sessionViewScope(session.id, session.workbenchProjectId),
                        currentPath,
                    ),
                    options.paneId,
                );
            return currentPath;
        });
        return opened ?? false;
    } finally {
        finishDocumentOperation(operation);
    }
}

/**
 * Applies an edit to the pane's Session and Workbench Root, even when another kept-alive Session is selected.
 */
export function changeDocument(
    sessionId: string,
    workbenchProjectId: string,
    path: string,
    content: string,
): void {
    const current = sessionStateOf(sessionId);
    if (current?.workbenchProjectId !== workbenchProjectId) return;
    const document = getSessionDocuments(sessionId, workbenchProjectId)?.[path];
    if (document?.readOnly) return;
    useSessionViewStore
        .getState()
        .updateDocumentContent(sessionId, path, content, workbenchProjectId);
    /**
     * An edit pins the preview it was typed into. Only the edited occurrence is pinned: the same document previewed in
     * another pane is a separate tab and keeps its own preview state.
     */
    const previewTab = findResourceTabs(current.paneLayout, { kind: 'file', path }).find(
        ({ tab }) => tab.preview,
    );
    if (previewTab) pinDocumentTab(sessionId, previewTab.tab.id);
}

/**
 * Turns a preview tab into a durable one, keyed by the tab occurrence rather than by its path.
 */
export function pinDocumentTab(sessionId: string, tabId: string): void {
    const current = sessionStateOf(sessionId);
    if (!current) return;
    const next = pinPaneTab(current.paneLayout, tabId);
    if (next !== current.paneLayout) patchSessionState({ ...current, paneLayout: next });
}

/**
 * Writes one document's current content to disk; returns false only when the write itself failed.
 */
async function didSaveDocumentAt(sessionId: string, path: string): Promise<boolean> {
    const document = getSessionDocuments(sessionId)?.[path];
    if (!document || document.readOnly) return true;
    const operation = trackDocumentOperation(sessionId, path);
    const retryState = sessionStateOf(sessionId);
    const retryTab = retryState
        ? findResourceTabs(retryState.paneLayout, { kind: 'file', path }).at(0)?.tab
        : undefined;
    // A dirty edit pins its preview. Refuse recovery through a reusable preview slot instead of saving a replacement.
    const retryTabId = retryTab?.preview ? undefined : retryTab?.id;
    let isSaved = false;
    try {
        await tryCommand(
            'Save failed',
            async () => {
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
            },
            {
                recovery: () => ({
                    id: 'editor.retrySave',
                    params: {
                        sessionId,
                        tabId: retryTabId,
                        workbenchProjectId: operation.workbenchProjectId,
                    },
                }),
            },
        );
    } finally {
        finishDocumentOperation(operation);
    }
    return isSaved;
}

type SaveRetryTarget = ToastActionParameters['editor.retrySave'];

/**
 * Which editor a failed save would be retried in, or undefined once there is no longer one.
 *
 * The buffer itself is deliberately not part of a retry's identity: it is re-read at retry time so a retry cannot
 * overwrite edits made after the failure; so all that has to survive the notification is the tab. A preview tab is
 * refused outright: recovering through a reusable slot would save a replacement document.
 */
function retrySaveTarget(target: SaveRetryTarget): FileTabTarget | undefined {
    const state = sessionStateOf(target.sessionId);
    const tab = state && target.tabId ? findTab(state.paneLayout, target.tabId)?.tab : undefined;
    return state?.workbenchProjectId === target.workbenchProjectId &&
        tab?.resource.kind === 'file' &&
        tab.preview !== true
        ? { path: tab.resource.path }
        : undefined;
}

interface FileTabTarget {
    path: string;
}

export function saveRetryUnavailableReason(target: SaveRetryTarget): string | undefined {
    return retrySaveTarget(target)
        ? undefined
        : 'Save retry is no longer available because the editor was closed or its Project changed.';
}

/**
 * Saves the document a failed save belonged to, from whatever its buffer holds now.
 */
export function retrySaveDocument(target: SaveRetryTarget): void {
    const resolved = retrySaveTarget(target);
    if (!resolved) return;
    // eslint-disable-next-line no-void -- tryCommand reports retry failures through the toast
    void didSaveDocumentAt(target.sessionId, resolved.path);
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
 * time (macOS only ever shows one modal sheet). Choosing Cancel on any of them aborts the whole close: a bulk Close
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
        if (choice === 'save' && !(await didSaveDocumentAt(sessionId, path))) return false;
    }
    return true;
}

/**
 * Closes explicitly selected tabs after the caller resolves the appropriate resource family. A dirty document is
 * confirmed (Save/Don't Save/Cancel) before anything is evicted, and the layout is re-read after that round trip in
 * case a concurrent operation (rename, Trash) changed it meanwhile. A Terminal among the closed tabs must give up its
 * PTY through the Server lifecycle in the same pass: merely dropping its tab from the layout would leave the process
 * running with nothing left to show or close it.
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
 * Close families resolved against the tab's own pane, on the scoping rules `paneTabIdsToClose` documents: an editor's
 * bulk close never reaches a Terminal, while a Terminal's reaches the documents beside it.
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

/**
 * Every Session that can hold editor state for one Workbench Root. A file path belongs to the root it was authorized
 * against, and a Session parked on a different root keeps the old root's documents cached under that root's scope, so
 * the set cannot be narrowed to the Sessions currently showing the root. `getProjectSessionIds` narrows exactly that
 * way and therefore misses them; a dirty buffer left behind recreates a trashed file on the next save (issue #738).
 * `remapOpenEditorsDurably` already reconciles the same full set for renames.
 */
function workbenchRootSessionIds(): string[] {
    return getBootstrap()?.sessions.map((session) => session.id) ?? [];
}

function closeOpenEditorsUnderPathInSession(
    sessionId: string,
    workbenchProjectId: string,
    path: string,
): void {
    discardPendingDocumentOperations(sessionId, path);
    /**
     * Evicted before the tab check, and for every root-holding Session: a dirty buffer whose tab is already closed is
     * still unsaved content that reopens with the persisted layout, which is the shape that resurrected the file.
     */
    useSessionViewStore.getState().evictDocumentsUnderPath(sessionId, path, workbenchProjectId);
    const current = sessionStateOf(sessionId);
    // Only this root's pane layout is in memory; closing tabs from a Session parked elsewhere would close the wrong root.
    if (!current || current.workbenchProjectId !== workbenchProjectId) return;
    const closingIds = listPaneTabs(current.paneLayout).flatMap(({ tab }) =>
        tab.resource.kind === 'file' &&
        !isVirtualEditorTabPath(tab.resource.path) &&
        isPathAtOrBelow(tab.resource.path, path)
            ? [tab.id]
            : [],
    );
    if (closingIds.length === 0) return;
    patchSessionState(
        { ...current, paneLayout: closeTabs(current.paneLayout, closingIds) },
        'Trashed editor state could not be saved',
    );
}

/**
 * Closes matching normal editors and drops matching cached documents in every Session holding state for the trashed
 * path's Workbench Root, after Main confirms Trash.
 *
 * `workbenchProjectId` is the root the caller resolved _before_ it awaited the Trash confirmation. Re-deriving it here
 * would reintroduce the same defect from the other side: a Session can change roots while the dialog is open (an Agent
 * creating a worktree does it without the user touching anything when `workbench.newWorktreeBehavior` is
 * `continueAutomatically`) and the cleanup would then miss the root the confirmation was actually about.
 */
export function closeOpenEditorsUnderPath(workbenchProjectId: string, path: string): void {
    for (const rootSessionId of workbenchRootSessionIds())
        closeOpenEditorsUnderPathInSession(rootSessionId, workbenchProjectId, path);
}

/**
 * True when a file at or below `path` has unsaved edits in any Session holding state for this Workbench Root. Lets a
 * Trash confirmation stop promising full recoverability when it would actually discard a dirty buffer that was never
 * written to disk.
 *
 * The evidence is the scoped document cache rather than the pane layout, deliberately: a Session parked on another root
 * has no layout for this one in memory, and the cache is what recreates the trashed file once the user switches back
 * and saves. Reading the same state {@link closeOpenEditorsUnderPath} evicts is the point: the confirmation promising
 * one thing while the cleanup discards another is the defect shape issue #738 reported. A dirty document always has a
 * cache entry, so this still covers every open dirty tab.
 */
export function hasUnsavedChangesUnderPath(workbenchProjectId: string, path: string): boolean {
    return workbenchRootSessionIds().some((rootSessionId) =>
        Object.entries(getSessionDocuments(rootSessionId, workbenchProjectId) ?? {}).some(
            ([candidate, document]) =>
                document.dirty &&
                !isVirtualEditorTabPath(candidate) &&
                isPathAtOrBelow(candidate, path),
        ),
    );
}
