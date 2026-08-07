import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import type { CaxriMethod } from '@shared/ipc';

import { caxri } from '../lib/caxri';

/** Debounce window used to coalesce a burst of `files.changed` events into one invalidation pass. */
const FILE_CHANGE_INVALIDATION_DEBOUNCE_MS = 150;

/**
 * Invalidates the Session-scoped read queries that a `files.changed` event cheaply reflects: Git
 * status and diffs. `files.list` is deliberately excluded — {@link FileTreePanel} tracks which
 * directories a change actually touched and invalidates only those, which this session-wide pass
 * would otherwise blur. `projectStatus.summary`/`projectStatus.overview` are excluded too: unlike
 * `git.summary`, a Project Status read may shell out to a delivery CLI (e.g. `gh`), so it stays on
 * its own polling interval instead of re-running on every file write.
 */
function invalidateFileDependentQueries(
    queryClient: ReturnType<typeof useQueryClient>,
    sessionId: string,
): void {
    const sessionScoped = new Set<CaxriMethod>(['git.summary', 'git.diff', 'git.diffDocument']);
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [method, params] = query.queryKey as [
                CaxriMethod,
                { sessionId?: string } | undefined,
            ];
            return sessionScoped.has(method) && params?.sessionId === sessionId;
        },
    });
}

/** `files.exclude` is global, so any valid settings reload refreshes every visible tree listing. */
function invalidateFileTreeQueries(queryClient: ReturnType<typeof useQueryClient>): void {
    void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'files.list',
    });
}

/**
 * Wires `caxri.onEvent` runtime pushes to targeted query invalidation. Mounted once at the app root
 * (see `App.tsx`) alongside the existing Zustand `subscribeWorkbenchEvents` wiring — Session/Project
 * bootstrap state stays on that push-based Zustand path; this hook only owns the request/response
 * reads that moved to React Query.
 */
export function useRuntimeQueryInvalidation(): void {
    const queryClient = useQueryClient();
    useEffect(() => {
        const pendingTimers = new Map<string, number>();
        const unsubscribe = caxri.onEvent((event) => {
            if (event.event === 'settings.changed') {
                if (!event.payload.error) invalidateFileTreeQueries(queryClient);
                return;
            }
            if (event.event !== 'files.changed') return;
            const { sessionId } = event.payload;
            const existing = pendingTimers.get(sessionId);
            if (existing !== undefined) window.clearTimeout(existing);
            pendingTimers.set(
                sessionId,
                window.setTimeout(() => {
                    pendingTimers.delete(sessionId);
                    invalidateFileDependentQueries(queryClient, sessionId);
                }, FILE_CHANGE_INVALIDATION_DEBOUNCE_MS),
            );
        });
        return () => {
            unsubscribe();
            for (const timer of pendingTimers.values()) window.clearTimeout(timer);
        };
    }, [queryClient]);
}
