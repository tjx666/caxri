import type {
    EditorNavigationTarget,
    FileDocument,
    PaneLayout,
    PaneTabCloseMode,
} from '@caxri/protocol';
import {
    activePane,
    CaxriError,
    closeTabs,
    filePreviewTabPath,
    findResourceTabs,
    findTab,
    isBinaryFileReadError,
    isUntitledEditorTabPath,
    isVirtualEditorTabPath,
    openResource,
    paneTabIdsToClose,
    pinPaneTab,
} from '@caxri/protocol';
import { editorModelPath } from '@desktop-shared/editor-state';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { getBootstrap, getSelectedSession, getSessionState } from '../../stores/selectors';
import {
    getSessionDocuments,
    sessionViewScope,
    useSessionViewStore,
} from '../../stores/session-view';
import { tryCommand } from '../../stores/toasts';
import { patchSessionState } from '../../stores/workbench';
import { recordClosedTabs } from '../closed-items/recording';
import { previewOnlyTabPath } from '../preview/preview-registry';
import { closeTerminal } from '../terminal/terminal-commands';
import { getActivePaneTab, getPaneLayout } from '../workbench/pane-actions';
import {
    layoutCachedDocumentPaths,
    layoutDocumentPaths,
    survivingCachedDocumentPaths,
} from './document-layout-paths';
import { isSavableEditorPath, writeEditorDocument } from './document-write-commands';
import { resolveDirtyEditorClose } from './editor-auto-save-commands';
import {
    beginFileOpenIntent,
    isCurrentFileOpenIntent,
    supersedePendingFileOpens,
} from './editor-open-intent';
import { markEditorDocumentReady, markEditorOpenStarted } from './editor-performance';
import { focusEditor, queueEditorNavigation, revealEditorNavigation } from './editor-reveal';
import { finishDocumentOperation, trackDocumentOperation } from './pending-document-operations';
import { isRecordableRecentFile } from './recent-files';
import { rememberRecentFile } from './recent-files-store';
import {
    createSaveFailureTracker,
    saveFailedLabel,
    saveFailureKey,
    subscribeSaveFailureCleanup,
    writeReportingNewFailures,
} from './save-failure-tracker';
import { persistOpenedEditorTab, sessionStateOf } from './session-pane-state';
import { forgetUntitledLanguage } from './untitled/language-detection-client';
import { untitledLanguageKey } from './untitled/language-store';
import { untitledDisplayName } from './untitled/names';
import { saveUntitledDocument } from './untitled/save-commands';

interface OpenFileOptions {
    focus?: boolean;
    location?: EditorNavigationTarget;
    /**
     * Exact split pane that should own preview placement and Editor focus.
     */
    paneId?: string;
    preview?: boolean;
}

function isDocumentDirty(
    sessionId: string,
    path: string,
    workbenchRootProjectId?: string,
): boolean {
    return getSessionDocuments(sessionId, workbenchRootProjectId)?.[path]?.dirty === true;
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
    const workbenchRootProjectId = current.workbenchRootProjectId;
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
    const surviving = new Set(layoutCachedDocumentPaths(opened));
    const replacedPaths = [
        ...new Set(
            layoutCachedDocumentPaths(current.paneLayout).filter((path) => !surviving.has(path)),
        ),
    ];
    const replacedDocuments = replacedPaths.flatMap((replaced) => {
        const document = getSessionDocuments(sessionId, workbenchRootProjectId)?.[replaced];
        return document ? [document] : [];
    });
    if (options.location && (wasOpen || opened !== current.paneLayout)) {
        const modelPath = editorModelPath(
            sessionViewScope(sessionId, workbenchRootProjectId),
            path,
        );
        if (wasMounted) revealEditorNavigation(modelPath, options.location);
        else queueEditorNavigation(modelPath, options.location);
    }
    for (const replaced of replacedPaths)
        view.evictDocument(sessionId, replaced, workbenchRootProjectId);
    view.touchDocument(sessionId, path, workbenchRootProjectId);
    if (opened === current.paneLayout) return true;
    /**
     * Fire-and-forget: the caller already sees this tab optimistically. Persisting continues in the background,
     * retrying once against a refreshed snapshot on a lost revision race (see `persistOpenedEditorTab`).
     */
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
 * Opens an editor tab in the currently selected Session, in `paneId` when given, else the active pane.
 *
 * The tab activates synchronously, so it supersedes any file open still awaiting `files.read`: otherwise a Settings
 * shortcut pressed right after a File Explorer click opens Settings, then the late read re-activates the file on top of
 * it.
 */
export function openEditorTab(path: string, options: { paneId?: string; preview?: boolean } = {}) {
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
        await tryCommand(translate('editor.document.openFailed'), async () => {
            try {
                const document = await caxri.request('files.read', { sessionId, path });
                /**
                 * A read only fills a missing document. When the buffer became unsaved while the read was in flight
                 * (typing, a hot-exit restore, or a second read StrictMode started), the buffer is newer than disk.
                 */
                const isUnsaved = getSessionDocuments(
                    sessionId,
                    operation.workbenchRootProjectId,
                )?.[operation.path]?.dirty;
                if (!isUnsaved && !operation.discarded) {
                    useSessionViewStore.getState().cacheDocument(
                        sessionId,
                        {
                            ...document,
                            path: operation.path,
                            dirty: false,
                        },
                        operation.workbenchRootProjectId,
                    );
                    /**
                     * Admission is budgeted, and a freshly read document is the newest entry rather than a protected
                     * one, so the very write that admits it can evict it again when the Session already holds more
                     * unsaved work than the cache allows. Reporting success then left the editor on a spinner that
                     * nothing re-triggers, which is the state issue #979 exists to remove.
                     */
                    const cached = getSessionDocuments(
                        sessionId,
                        operation.workbenchRootProjectId,
                    )?.[operation.path];
                    if (!cached)
                        throw new CaxriError('CAPACITY', translate('editor.document.noRoom'));
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
 * Adds a file that just opened as an editor tab to its Workbench Root's recent-files history (see `recent-files.ts`).
 */
function rememberOpenedFile(session: { workbenchRootProjectId: string }, path: string): void {
    const root = getBootstrap()?.projects.find(
        (project) => project.id === session.workbenchRootProjectId,
    )?.rootPath;
    if (root && isRecordableRecentFile(root, path))
        rememberRecentFile(session.workbenchRootProjectId, path);
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
    /**
     * A format with no text form (a PDF) opens as its preview tab: a text read could only fail on the binary content.
     * Routing here covers every open path at once (Files, Quick Open, project search, Terminal links).
     */
    const previewTabPath = previewOnlyTabPath(path, sessionStateOf(session.id)?.paneLayout);
    if (previewTabPath) {
        supersedePendingFileOpens();
        const didOpen = didOpenEditorTabForSession(session.id, previewTabPath, {
            paneId: options.paneId,
            preview: options.preview,
        });
        if (didOpen) rememberOpenedFile(session, path);
        return didOpen ? path : false;
    }
    const intent = beginFileOpenIntent();
    const operation = trackDocumentOperation(session.id, path);
    const wasDirty = isDocumentDirty(session.id, path);
    markEditorOpenStarted();
    try {
        const opened = await tryCommand(translate('editor.document.openFileFailed'), async () => {
            /**
             * Binary content is only known once read. Such a file has no text to edit, so it opens as a no-preview tab
             * offering Reveal in Finder instead of failing with a toast (https://github.com/tjx666/caxri/issues/1921).
             */
            let document: FileDocument | undefined;
            try {
                document = await caxri.request('files.read', { sessionId: session.id, path });
            } catch (error) {
                if (!isBinaryFileReadError(error)) throw error;
            }
            if (
                !isCurrentFileOpenIntent(intent) ||
                operation.discarded ||
                !getBootstrap()?.sessions.some((candidate) => candidate.id === session.id) ||
                getBootstrap()?.sessions.find((candidate) => candidate.id === session.id)
                    ?.workbenchRootProjectId !== operation.workbenchRootProjectId
            )
                return false;
            const currentPath = operation.path;
            if (!document) {
                const didOpen = didOpenEditorTabForSession(
                    session.id,
                    filePreviewTabPath(currentPath),
                    { paneId: options.paneId, preview: options.preview },
                );
                return didOpen && currentPath;
            }
            markEditorDocumentReady();
            /**
             * Reopening a file the user is still editing shows their buffer, not the read. Checked on both sides of the
             * read: a save in flight (auto save on the click that reopens the file) clears dirty before the read
             * lands.
             */
            if (
                !wasDirty &&
                !isDocumentDirty(session.id, currentPath, operation.workbenchRootProjectId)
            )
                useSessionViewStore
                    .getState()
                    .cacheDocument(
                        session.id,
                        { ...document, path: currentPath, dirty: false },
                        operation.workbenchRootProjectId,
                    );
            const didOpen = didOpenEditorTabForSession(session.id, currentPath, options);
            if (didOpen && options.focus)
                focusEditor(
                    editorModelPath(
                        sessionViewScope(session.id, session.workbenchRootProjectId),
                        currentPath,
                    ),
                    options.paneId,
                );
            return currentPath;
        });
        if (opened) rememberOpenedFile(session, opened);
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
    workbenchRootProjectId: string,
    path: string,
    content: string,
): void {
    const current = sessionStateOf(sessionId);
    if (current?.workbenchRootProjectId !== workbenchRootProjectId) return;
    const document = getSessionDocuments(sessionId, workbenchRootProjectId)?.[path];
    if (document?.readOnly) return;
    useSessionViewStore
        .getState()
        .updateDocumentContent(sessionId, path, content, workbenchRootProjectId);
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

const saveFailures = createSaveFailureTracker();

/**
 * Keeps the save failure records in step with the document cache for the lifetime of the Workbench window.
 */
export function subscribeDocumentSaveFailureCleanup(): () => void {
    return subscribeSaveFailureCleanup(saveFailures);
}

/**
 * Save As for an untitled buffer, reported like any other save: a failed write gets the save-failure toast, and a
 * dismissed dialog is a quiet "not saved" that keeps the buffer and its tab.
 */
async function didSaveUntitledDocument(sessionId: string, path: string): Promise<boolean> {
    const name = untitledDisplayName(
        path,
        getSessionDocuments(sessionId)?.[path]?.content ?? '',
        translate,
    );
    const outcome = await tryCommand(translate('editor.document.saveFailedFile', { name }), () =>
        saveUntitledDocument(sessionId, path),
    );
    return outcome === 'saved';
}

/**
 * Writes one document's current content to disk; returns false only when the write itself failed. An automatic save
 * (`isAutomatic`) stays quiet about a failure the user was already told about for this file; a manual save always shows
 * its failure.
 */
export async function didSaveDocumentAt(
    sessionId: string,
    path: string,
    options: { isAutomatic?: boolean } = {},
): Promise<boolean> {
    const document = getSessionDocuments(sessionId)?.[path];
    if (!document || document.readOnly) return true;
    if (isUntitledEditorTabPath(path))
        return !options.isAutomatic && (await didSaveUntitledDocument(sessionId, path));
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
            saveFailedLabel(path),
            async () => {
                const result = await writeReportingNewFailures(
                    saveFailures,
                    saveFailureKey(sessionId, path),
                    options.isAutomatic === true,
                    () => writeEditorDocument(sessionId, path, document.content),
                );
                if (!result) return;
                if (!operation.discarded) {
                    const current = getSessionDocuments(
                        sessionId,
                        operation.workbenchRootProjectId,
                    )?.[operation.path];
                    if (current) {
                        const isChangedDuringSave = current.content !== document.content;
                        useSessionViewStore.getState().cacheDocument(
                            sessionId,
                            {
                                // Keeps an external document's display path and ephemeral lifetime.
                                ...current,
                                ...result,
                                path: operation.path,
                                content: isChangedDuringSave ? current.content : result.content,
                                dirty: isChangedDuringSave,
                            },
                            operation.workbenchRootProjectId,
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
                        workbenchRootProjectId: operation.workbenchRootProjectId,
                    },
                }),
            },
        );
    } finally {
        finishDocumentOperation(operation);
    }
    return isSaved;
}

export async function saveActiveEditor(): Promise<void> {
    const session = getSelectedSession();
    const active = getActivePaneTab();
    if (!session || active?.resource.kind !== 'file') return;
    const path = active.resource.path;
    if (!isSavableEditorPath(path)) return;
    await didSaveDocumentAt(session.id, path);
}

/**
 * Confirms discarding unsaved changes for each dirty tab about to close, one native "Do you want to save…" sheet at a
 * time (macOS only ever shows one modal sheet), unless auto save resolves it as Save without asking. Choosing Cancel on
 * any of them aborts the whole close: a bulk Close Others/Close All must never end up half applied, silently dropping
 * some dirty buffers while leaving others open.
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
                if (remaining.has(path) || !isSavableEditorPath(path)) return [];
                return isDocumentDirty(sessionId, path) ? [path] : [];
            }),
        ),
    ];
    for (const path of dirtyPaths) {
        // Intentionally sequential: macOS only ever shows one modal "Do you want to save…" sheet, so
        // each confirmation must resolve before the next one is requested.
        // eslint-disable-next-line no-await-in-loop -- intentional sequential await, see comment above
        const choice = await resolveDirtyEditorClose(
            path,
            getSessionDocuments(sessionId)?.[path]?.content,
        );
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
    // Before the eviction below, which drops an external document's only copy.
    recordClosedTabs(session.id, current.paneLayout, remainingIds, (path) =>
        isDocumentDirty(session.id, path),
    );
    const survivingPaths = survivingCachedDocumentPaths(next, (path) =>
        isDocumentDirty(session.id, path),
    );
    for (const path of layoutCachedDocumentPaths(current.paneLayout))
        if (!survivingPaths.has(path)) {
            useSessionViewStore.getState().evictDocument(session.id, path);
            if (isUntitledEditorTabPath(path))
                forgetUntitledLanguage(
                    untitledLanguageKey(
                        sessionViewScope(session.id, session.workbenchRootProjectId),
                        path,
                    ),
                );
        }
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
