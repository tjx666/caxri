import { useEffect } from 'react';

import type { CaxriMethod } from '@shared/ipc';
import type { QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';

import { caxri } from '../lib/caxri';
import { getWorkbenchProjectSessionIds } from '../stores/selectors';

/**
 * Debounce window used to coalesce a burst of `files.changed` events into one invalidation pass.
 */
const FILE_CHANGE_INVALIDATION_DEBOUNCE_MS = 150;

/**
 * Invalidates the Session-scoped read queries that a `files.changed` event cheaply reflects: only the file-tree
 * `files.browse` listing today. `files.list` is deliberately excluded — the separate Project-scoped file-tree
 * subscription tracks which directories a change actually touched and invalidates only those, which this broad query
 * pass would otherwise blur. `projectStatus.summary` and `projectStatus.overview` are excluded too: a Project Status
 * read may shell out to a delivery CLI (e.g. `gh`), so it stays on its own polling interval instead of re-running on
 * every file write. Git status/diff/blame queries (`git.summary`, `git.overview`, `git.diffDocument`, `git.blame`) are
 * no longer invalidated from here: a plain file write does not always mean the working tree changed (e.g. an ignored
 * file), so Git invalidation instead rides the Runtime-emitted `git.changed` event, which is scoped to the repository
 * identities that actually changed — see `invalidateGitChangedQueries` below.
 */
function invalidateFileDependentQueries(
    queryClient: QueryClient,
    sessionIds: readonly string[],
): void {
    const sessionScoped = new Set<CaxriMethod>(['files.browse']);
    // Fire-and-forget: the invalidated queries surface their own errors through React Query's
    // per-query error state, so the caller never needs to await or handle this rejection.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [method, parameters] = query.queryKey as [
                CaxriMethod,
                { sessionId?: string } | undefined,
            ];
            return (
                sessionScoped.has(method) &&
                parameters?.sessionId !== undefined &&
                sessionIds.includes(parameters.sessionId)
            );
        },
    });
}

/**
 * Invalidates the Session-scoped Git read queries a `git.changed` event covers: status/topology (`git.summary`,
 * `git.overview`), file diffs (`git.diffDocument`), and current-line blame (`git.blame`). Unlike
 * {@link invalidateFileDependentQueries}, this runs unconditionally on every `git.changed` push — the Runtime already
 * coalesces bursts of repository activity into one event before emitting it, so no additional client-side debounce is
 * needed here.
 */
function invalidateGitChangedQueries(
    queryClient: QueryClient,
    sessionIds: readonly string[],
): void {
    const sessionScoped = new Set<CaxriMethod>([
        'git.summary',
        'git.overview',
        'git.diffDocument',
        'git.blame',
    ]);
    // Fire-and-forget: see the justification in invalidateFileDependentQueries above.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [method, parameters] = query.queryKey as [
                CaxriMethod,
                { sessionId?: string } | undefined,
            ];
            return (
                sessionScoped.has(method) &&
                parameters?.sessionId !== undefined &&
                sessionIds.includes(parameters.sessionId)
            );
        },
    });
}

/**
 * Drops every cached query keyed to one of `sessionIds` from the React Query cache. Called once a Session (or, with
 * every Session of a Project, a Project) is deleted — otherwise the cached reads (Git status, diffs, blame, file
 * listings, ...) linger under the removed sessionId until the default garbage collector reclaims them, even though the
 * Session can never be selected again. Unlike {@link invalidateFileDependentQueries}, this matches any method: a deleted
 * Session's data should never resurface, not just the file-dependent subset.
 */
export function removeSessionQueries(
    queryClient: QueryClient,
    sessionIds: readonly string[],
): void {
    if (sessionIds.length === 0) return;
    const removedSessionIds = new Set(sessionIds);
    queryClient.removeQueries({
        predicate: (query) => {
            const [, parameters] = query.queryKey as [
                CaxriMethod,
                { sessionId?: string } | undefined,
            ];
            return (
                parameters?.sessionId !== undefined && removedSessionIds.has(parameters.sessionId)
            );
        },
    });
}

/**
 * `files.exclude` is global, so any valid settings reload refreshes every visible tree listing.
 */
function invalidateFileTreeQueries(queryClient: ReturnType<typeof useQueryClient>): void {
    // Fire-and-forget: see the justification in invalidateFileDependentQueries above.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        predicate: (query) =>
            query.queryKey[0] === 'files.list' || query.queryKey[0] === 'files.browse',
    });
}

/**
 * Wires `caxri.onEvent` runtime pushes to targeted query invalidation. Mounted once at the app root (see `app.tsx`)
 * alongside the existing Zustand `subscribeWorkbenchEvents` wiring — Session/Project bootstrap state stays on that
 * push-based Zustand path; this hook only owns the request/response reads that moved to React Query.
 */
export function useRuntimeQueryInvalidation(): void {
    const queryClient = useQueryClient();
    useEffect(() => subscribeRuntimeQueryInvalidation(queryClient), [queryClient]);
}

/**
 * Subscribes the query cache to Runtime events. The debounce is keyed by Workbench Project rather than source Session
 * because every Session currently routed to that root observes the same disk.
 */
export function subscribeRuntimeQueryInvalidation(queryClient: QueryClient): () => void {
    const pendingTimers = new Map<string, number>();
    const unsubscribe = caxri.onEvent((event) => {
        if (event.event === 'workbench.changed') {
            removeSessionQueries(queryClient, [event.payload.sessionId]);
            return;
        }
        if (event.event === 'settings.changed') {
            if (!event.payload.error) invalidateFileTreeQueries(queryClient);
            return;
        }
        if (event.event === 'git.changed') {
            invalidateGitChangedQueries(queryClient, event.payload.sessionIds);
            return;
        }
        if (event.event !== 'files.changed') return;
        const { sessionId, workbenchProjectId } = event.payload;
        const existing = pendingTimers.get(workbenchProjectId);
        if (existing !== undefined) clearTimeout(existing);
        pendingTimers.set(
            workbenchProjectId,
            setTimeout(() => {
                pendingTimers.delete(workbenchProjectId);
                invalidateFileDependentQueries(
                    queryClient,
                    getWorkbenchProjectSessionIds(workbenchProjectId, sessionId),
                );
            }, FILE_CHANGE_INVALIDATION_DEBOUNCE_MS),
        );
    });
    return () => {
        unsubscribe();
        for (const timer of pendingTimers.values()) clearTimeout(timer);
    };
}
