import type { CaxriMethod } from '@caxri/protocol';
import type { Query, QueryClient } from '@tanstack/react-query';

/**
 * Drops every cached query keyed to one of `sessionIds` from the React Query cache. Called once a Session (or, with
 * every Session of a Project, a Project) is deleted, otherwise the cached reads (Git status, diffs, blame, file
 * listings, ...) linger under the removed sessionId until the default garbage collector reclaims them, even though the
 * Session can never be selected again. Unlike `invalidateFileDependentQueries`, this matches any method: a deleted
 * Session's data should never resurface, not just the file-dependent subset.
 */
export function removeSessionQueries(
    queryClient: QueryClient,
    sessionIds: readonly string[],
): void {
    if (sessionIds.length === 0) return;
    queryClient.removeQueries({ predicate: sessionQueryPredicate(sessionIds) });
}

export function sessionQueryPredicate(sessionIds: readonly string[]): (query: Query) => boolean {
    const matchedSessionIds = new Set(sessionIds);
    return (query) => {
        const [, parameters] = query.queryKey as [
            CaxriMethod,
            { contextKey?: string; sessionId?: string } | undefined,
        ];
        if (parameters?.sessionId !== undefined) return matchedSessionIds.has(parameters.sessionId);
        /**
         * Controlled views and Extension Trees identify their Session through the `${sessionId}:...` context key rather
         * than a `sessionId` parameter, so the sweep has to recognize both shapes, otherwise a deleted Session's cached
         * views survive until garbage collection, which the Extension Tree deliberately delays.
         */
        const contextKey = parameters?.contextKey;
        if (contextKey === undefined) return false;
        return matchedSessionIds
            .values()
            .some((sessionId) => contextKey.startsWith(`${sessionId}:`));
    };
}
