import type { SessionState } from '@caxri/protocol';
import { findResourceTabs, openResource } from '@caxri/protocol';
import type { EditorDocument } from '@desktop-shared/editor-state';

import { useSessionViewStore } from '../../stores/session-view';
import { refreshWorkbench, useWorkbenchStore } from '../../stores/workbench';

export function sessionStateOf(sessionId: string): SessionState | undefined {
    return useWorkbenchStore
        .getState()
        .bootstrap?.sessionStates.find((state) => state.sessionId === sessionId);
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
export async function persistOpenedEditorTab(
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
