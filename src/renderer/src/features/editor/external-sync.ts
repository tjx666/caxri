import { useEffect } from 'react';

import { markTabsClean, replaceWithExternalDocument } from '@shared/editor-state';
import { isGitDiffTabPath } from '@shared/git-diff';
import type { FileDocument } from '@shared/types';

import { caxri } from '../../lib/caxri';
import { getSelectedSession, getSessionState, selectSelectedSession } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import { pushToast } from '../../stores/toasts';
import { patchSessionState, useWorkbenchStore } from '../../stores/workbench';

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
    void readDocuments(sessionId, uniquePaths).then((reloaded) =>
        applyExternalDocuments(sessionId, reloaded),
    );
}

/**
 * Re-reads the cached buffers of a Session that just became selected. Its watcher events were
 * ignored while another Session held the center pane, so the buffers can be arbitrarily stale.
 */
function reconcileSelectedSession(sessionId: string): void {
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
    useEffect(() => {
        const unsubscribeEvents = caxri.onEvent((event) => {
            if (event.event !== 'files.changed') return;
            const sessionId = getSelectedSession()?.id;
            if (!sessionId || event.payload.sessionId !== sessionId) return;
            const cached = useSessionViewStore.getState().documents[sessionId] ?? {};
            const changedPaths: string[] = [];
            if (event.payload.overflow) {
                for (const tab of getSessionState()?.openTabs ?? [])
                    if (!isGitDiffTabPath(tab.path)) changedPaths.push(tab.path);
            } else {
                for (const change of event.payload.changes)
                    if (change.kind !== 'delete' && cached[change.path])
                        changedPaths.push(change.path);
            }
            onFilesChanged(sessionId, changedPaths);
        });
        const unsubscribeSelection = useWorkbenchStore.subscribe((state, previous) => {
            const sessionId = selectSelectedSession(state.bootstrap)?.id;
            const previousSessionId = selectSelectedSession(previous.bootstrap)?.id;
            if (!sessionId || !previousSessionId || sessionId === previousSessionId) return;
            reconcileSelectedSession(sessionId);
        });
        return () => {
            unsubscribeEvents();
            unsubscribeSelection();
        };
    }, []);
}
