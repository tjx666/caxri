import { useEffect } from 'react';

import type { FileDocument } from '@caxri/protocol';
import { isVirtualEditorTabPath, listPaneTabs } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';
import { replaceWithExternalDocument } from '@desktop-shared/editor-state';
import { uniq } from 'es-toolkit';

import { caxri } from '../../lib/caxri';
import { getSelectedSession, getSessionState, selectSelectedSession } from '../../stores/selectors';
import { getSessionDocuments, useSessionViewStore } from '../../stores/session-view';
import { pushToast } from '../../stores/toasts';
import { useWorkbenchStore } from '../../stores/workbench';
import { useFileOperationStore } from '../view-containers/resource-explorer/file-operation-state';
import { readDocuments } from './document-commands';
import { ExternalSyncDeferral } from './external-sync-deferral';

/**
 * Every document path the selected Session currently has open, across all panes.
 */
function openDocumentPaths(): string[] {
    const layout = getSessionState()?.paneLayout;
    return layout
        ? uniq(
              listPaneTabs(layout).flatMap(({ tab }) =>
                  tab.resource.kind === 'file' ? [tab.resource.path] : [],
              ),
          )
        : [];
}

function isChangedOnDisk(cached: FileDocument, current: FileDocument): boolean {
    return cached.mtimeMs !== current.mtimeMs || cached.size !== current.size;
}

/**
 * Reads a cached document by path, surfacing `undefined` for a path never cached. `Record` indexing does not model the
 * missing-key case; `Object.hasOwn` recovers it explicitly instead of relying on an index access the type system treats
 * as always-defined.
 */
function readCachedDocument<T>(cached: Record<string, T>, path: string): T | undefined {
    return Object.hasOwn(cached, path) ? cached[path] : undefined;
}

/**
 * Caxri's explicit product policy: a newer disk state replaces the open buffer without prompting, even when that buffer
 * is dirty. Routine Agent writes to clean buffers stay silent; only discarded unsaved work is announced.
 */
function applyExternalDocuments(
    sessionId: string,
    workbenchProjectId: string,
    reloaded: readonly FileDocument[],
): void {
    const selected = getSelectedSession();
    if (
        reloaded.length === 0 ||
        selected?.id !== sessionId ||
        selected.workbenchProjectId !== workbenchProjectId
    )
        return;
    const cached = getSessionDocuments(sessionId, workbenchProjectId) ?? {};
    const discardedDirtyDocuments = reloaded.flatMap((document) => {
        const previous = readCachedDocument(cached, document.path);
        return previous?.dirty ? [previous] : [];
    });
    useSessionViewStore
        .getState()
        .cacheDocuments(sessionId, reloaded.map(replaceWithExternalDocument), workbenchProjectId);
    if (discardedDirtyDocuments.length === 0) return;
    /**
     * A 4-second auto-dismiss would let this notice vanish while the user is away from the window, silently taking the
     * only record of a discarded dirty buffer with it. This event already cost the user unsaved work, so it stays until
     * explicitly dismissed.
     */
    pushToast(
        'info',
        discardedDirtyDocuments.length === 1
            ? `${pathBasename(discardedDirtyDocuments[0].path)} reloaded from disk; external changes take precedence.`
            : `${discardedDirtyDocuments.length} open files reloaded from disk; external changes take precedence.`,
        { persist: true },
    );
}

async function syncFilesChanged(sessionId: string, changedPaths: readonly string[]): Promise<void> {
    const workbenchProjectId = getSelectedSession()?.workbenchProjectId;
    if (!workbenchProjectId) return;
    const uniquePaths = uniq(changedPaths);
    if (uniquePaths.length === 0) return;
    const documents = await readDocuments(sessionId, uniquePaths);
    const cached = getSessionDocuments(sessionId, workbenchProjectId) ?? {};
    applyExternalDocuments(
        sessionId,
        workbenchProjectId,
        documents.filter((document) => {
            const previous = readCachedDocument(cached, document.path);
            return previous && isChangedOnDisk(previous, document);
        }),
    );
}

function onFilesChanged(sessionId: string, changedPaths: readonly string[]): void {
    // Fire-and-forget: `syncFilesChanged` has no synchronous caller waiting on it: watcher events
    // apply asynchronously and any failure surfaces through the normal request-rejection path.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void syncFilesChanged(sessionId, changedPaths);
}

/**
 * Re-reads the cached buffers of a Session that just became selected. Its watcher events were ignored while another
 * Session held the center pane, so the buffers can be arbitrarily stale.
 */
async function syncReconcileSelectedSession(
    sessionId: string,
    workbenchProjectId: string,
    cached: Record<string, FileDocument>,
    paths: readonly string[],
): Promise<void> {
    const documents = await readDocuments(sessionId, paths);
    applyExternalDocuments(
        sessionId,
        workbenchProjectId,
        documents.filter((document) => {
            const previous = readCachedDocument(cached, document.path);
            return previous && isChangedOnDisk(previous, document);
        }),
    );
}

function reconcileSelectedSession(sessionId: string, shouldPreserveDirty = false): void {
    const selected = getSelectedSession();
    if (selected?.id !== sessionId) return;
    const workbenchProjectId = selected.workbenchProjectId;
    const cached = getSessionDocuments(sessionId, workbenchProjectId) ?? {};
    const paths: string[] = [];
    for (const path of openDocumentPaths()) {
        const cachedTab = readCachedDocument(cached, path);
        if (
            cachedTab &&
            !isVirtualEditorTabPath(path) &&
            (!shouldPreserveDirty || !cachedTab.dirty)
        )
            paths.push(path);
    }
    if (paths.length === 0) return;
    // Fire-and-forget: reconciliation has no synchronous caller waiting on it: a failed read
    // surfaces through the normal request-rejection path, and there is no result to return here.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void syncReconcileSelectedSession(sessionId, workbenchProjectId, cached, paths);
}

/**
 * Owns the external-change rule for open editors. Unlike its predecessor it takes no arguments: both the watcher stream
 * and the Session switch are read straight from the stores, so there is no state-to-ref mirror and no `setState`
 * dispatcher to thread through App.
 */
export function useExternalDocumentSync(): void {
    useEffect(subscribeExternalDocumentSync, []);
}

/**
 * Installs one shared boundary across watcher events, managed mutations, and Session selection.
 */
export function subscribeExternalDocumentSync(): () => void {
    const deferral = new ExternalSyncDeferral();
    const shouldDeferProject = (projectId: string): boolean =>
        deferral.deferIfPending(projectId, useFileOperationStore.getState().operations);
    const unsubscribeEvents = caxri.onEvent((event) => {
        if (event.event !== 'files.changed') return;
        const session = getSelectedSession();
        if (!session || event.payload.workbenchProjectId !== session.workbenchProjectId) return;
        const sessionId = session.id;
        const cached = getSessionDocuments(sessionId, session.workbenchProjectId) ?? {};
        const changedPaths: string[] = [];
        if (event.payload.overflow) {
            for (const path of openDocumentPaths())
                if (!isVirtualEditorTabPath(path)) changedPaths.push(path);
        } else {
            const changes = event.payload.changes;
            for (const change of changes)
                if (change.kind !== 'delete' && Object.hasOwn(cached, change.path))
                    changedPaths.push(change.path);
        }
        /**
         * A managed rename or move can emit a watcher batch before editor paths are remapped. Reconcile the current
         * paths after the operation settles instead of reading a path that stopped existing midway through the
         * mutation.
         */
        if (shouldDeferProject(session.workbenchProjectId)) return;
        onFilesChanged(sessionId, changedPaths);
    });
    const unsubscribeOperations = useFileOperationStore.subscribe((state) => {
        for (const projectId of deferral.flushReady(state.operations)) {
            const selected = getSelectedSession();
            if (selected?.workbenchProjectId === projectId) reconcileSelectedSession(selected.id);
        }
    });
    const unsubscribeSelection = useWorkbenchStore.subscribe((state, previous) => {
        const session = selectSelectedSession(state.bootstrap);
        const previousSession = selectSelectedSession(previous.bootstrap);
        if (
            !session ||
            !previousSession ||
            (session.id === previousSession.id &&
                session.workbenchProjectId === previousSession.workbenchProjectId)
        )
            return;
        if (shouldDeferProject(session.workbenchProjectId)) return;
        /**
         * Switching roots must reveal that root's retained dirty buffers verbatim. Ordinary Session selection still
         * applies the global external-change-wins policy.
         */
        reconcileSelectedSession(
            session.id,
            session.id === previousSession.id &&
                session.workbenchProjectId !== previousSession.workbenchProjectId,
        );
    });
    return () => {
        unsubscribeEvents();
        unsubscribeOperations();
        unsubscribeSelection();
    };
}
