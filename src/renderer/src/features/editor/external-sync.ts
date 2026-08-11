import { useEffect } from 'react';

import { markTabsClean, replaceWithExternalDocument } from '@shared/editor-state';
import { isGitDiffTabPath } from '@shared/git-diff';
import type { FileDocument } from '@shared/types';

import { caxri } from '../../lib/caxri';
import { getSelectedSession, getSessionState, selectSelectedSession } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import { pushToast } from '../../stores/toasts';
import { patchSessionState, useWorkbenchStore } from '../../stores/workbench';
import { useFileOperationStore } from '../inspector/panels/files/file-operation-state';
import { ExternalSyncDeferral } from './external-sync-deferral';

const fileName = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;

function changedOnDisk(cached: FileDocument, current: FileDocument): boolean {
    return cached.mtimeMs !== current.mtimeMs || cached.size !== current.size;
}

function readDocuments(sessionId: string, paths: readonly string[]): Promise<FileDocument[]> {
    return Promise.allSettled(
        paths.map((path) => caxri.request('files.read', { sessionId, path })),
    ).then((results) =>
        results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
    );
}

/**
 * Caxri's explicit product policy: a newer disk state replaces the open buffer without prompting,
 * even when that buffer is dirty. The reload is announced instead of negotiated.
 */
function applyExternalDocuments(sessionId: string, reloaded: readonly FileDocument[]): void {
    if (reloaded.length === 0 || getSelectedSession()?.id !== sessionId) return;
    useSessionViewStore
        .getState()
        .cacheDocuments(sessionId, reloaded.map(replaceWithExternalDocument));
    const latestState = getSessionState();
    if (latestState?.sessionId === sessionId) {
        patchSessionState(
            markTabsClean(
                latestState,
                reloaded.map((document) => document.path),
            ),
            'External editor state could not be saved',
        );
    }
    pushToast(
        'info',
        reloaded.length === 1
            ? `${fileName(reloaded[0].path)} reloaded from disk; external changes take precedence.`
            : `${reloaded.length} open files reloaded from disk; external changes take precedence.`,
    );
}

function onFilesChanged(sessionId: string, changedPaths: readonly string[]): void {
    const uniquePaths = [...new Set(changedPaths)];
    if (uniquePaths.length === 0) return;
    void readDocuments(sessionId, uniquePaths).then((documents) => {
        const cached = useSessionViewStore.getState().documents[sessionId] ?? {};
        applyExternalDocuments(
            sessionId,
            documents.filter((document) => {
                const previous = cached[document.path];
                return previous && changedOnDisk(previous, document);
            }),
        );
    });
}

/**
 * Re-reads the cached buffers of a Session that just became selected. Its watcher events were
 * ignored while another Session held the center pane, so the buffers can be arbitrarily stale.
 */
function reconcileSelectedSession(sessionId: string): void {
    if (getSelectedSession()?.id !== sessionId) return;
    const cached = useSessionViewStore.getState().documents[sessionId] ?? {};
    const paths: string[] = [];
    for (const tab of getSessionState()?.openTabs ?? [])
        if (!isGitDiffTabPath(tab.path) && cached[tab.path]) paths.push(tab.path);
    if (paths.length === 0) return;
    void readDocuments(sessionId, paths).then((documents) =>
        applyExternalDocuments(
            sessionId,
            documents.filter((document) => {
                const previous = cached[document.path];
                return previous && changedOnDisk(previous, document);
            }),
        ),
    );
}

/**
 * Owns the external-change rule for open editors. Unlike its predecessor it takes no arguments: both
 * the watcher stream and the Session switch are read straight from the stores, so there is no
 * state-to-ref mirror and no `setState` dispatcher to thread through App.
 */
export function useExternalDocumentSync(): void {
    useEffect(subscribeExternalDocumentSync, []);
}

/** Installs one shared boundary across watcher events, managed mutations, and Session selection. */
export function subscribeExternalDocumentSync(): () => void {
    const deferral = new ExternalSyncDeferral();
    const deferProject = (projectId: string): boolean =>
        deferral.deferIfPending(projectId, useFileOperationStore.getState().operations);
    const unsubscribeEvents = caxri.onEvent((event) => {
        if (event.event !== 'files.changed') return;
        const session = getSelectedSession();
        if (!session || event.payload.sessionId !== session.id) return;
        const sessionId = session.id;
        const cached = useSessionViewStore.getState().documents[sessionId] ?? {};
        const changedPaths: string[] = [];
        if (event.payload.overflow) {
            for (const tab of getSessionState()?.openTabs ?? [])
                if (!isGitDiffTabPath(tab.path)) changedPaths.push(tab.path);
        } else {
            for (const change of event.payload.changes)
                if (change.kind !== 'delete' && cached[change.path]) changedPaths.push(change.path);
        }
        /** A managed rename or move can emit a watcher batch before editor paths are remapped.
         * Reconcile the current paths after the operation settles instead of reading a path
         * that stopped existing midway through the mutation. */
        if (deferProject(session.projectId)) return;
        onFilesChanged(sessionId, changedPaths);
    });
    const unsubscribeOperations = useFileOperationStore.subscribe((state) => {
        for (const projectId of deferral.flushReady(state.operations)) {
            const selected = getSelectedSession();
            if (selected?.projectId === projectId) reconcileSelectedSession(selected.id);
        }
    });
    const unsubscribeSelection = useWorkbenchStore.subscribe((state, previous) => {
        const session = selectSelectedSession(state.bootstrap);
        const previousSession = selectSelectedSession(previous.bootstrap);
        if (!session || !previousSession || session.id === previousSession.id) return;
        if (deferProject(session.projectId)) return;
        reconcileSelectedSession(session.id);
    });
    return () => {
        unsubscribeEvents();
        unsubscribeOperations();
        unsubscribeSelection();
    };
}
