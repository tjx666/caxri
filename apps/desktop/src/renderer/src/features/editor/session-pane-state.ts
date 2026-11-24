import type { EditorNavigationTarget, SessionState } from '@caxri/protocol';
import { activePane, findResourceTabs, openResource } from '@caxri/protocol';
import type { EditorDocument } from '@desktop-shared/editor-state';
import { editorModelPath } from '@desktop-shared/editor-state';

import {
    getSessionDocuments,
    sessionViewScope,
    useSessionViewStore,
} from '../../stores/session-view';
import { refreshWorkbench, useWorkbenchStore } from '../../stores/workbench';
import { layoutCachedDocumentPaths } from './document-layout-paths';
import { queueEditorNavigation, revealEditorNavigation } from './editor-reveal';

export function sessionStateOf(sessionId: string): SessionState | undefined {
    return useWorkbenchStore
        .getState()
        .bootstrap?.sessionStates.find((state) => state.sessionId === sessionId);
}

/**
 * `openResource`'s write can lose a race against a brand-new Session's own initial Terminal-attach write and come back
 * `CONFLICT` ("stale revision") even though nothing the caller did was wrong: both writes originate from opening this
 * same Session for the first time (see `pickBotFileLinkSession` in Main), and the Session's very first
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
    const workbenchRootProjectId = next.workbenchRootProjectId;
    let isStale = false;
    const persisted = await useWorkbenchStore.getState().patchSessionState(
        next,
        undefined,
        () => {
            const currentView = useSessionViewStore.getState();
            if (!wasOpen) currentView.evictDocument(sessionId, path, workbenchRootProjectId);
            for (const document of replacedDocuments)
                currentView.cacheDocument(sessionId, document, workbenchRootProjectId);
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
    if (!current || current.workbenchRootProjectId !== workbenchRootProjectId) return;
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
