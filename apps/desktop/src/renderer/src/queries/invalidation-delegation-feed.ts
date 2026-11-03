import type {
    AgentDelegationProgress,
    CaxriMethod,
    MethodResult,
    SessionRecord,
} from '@caxri/protocol';
import type { QueryClient } from '@tanstack/react-query';
import { omit } from 'es-toolkit';

import { isQueryMethod } from './client';

/**
 * The Delegated Sessions feed behind the Project tree's nested rows. Its own module because it is the one read keyed by
 * a list of creating Sessions rather than by the Session a Server event names, so it needs a lookup the other
 * invalidations do not.
 */
const DELEGATION_FEED_METHOD = 'agent.delegation.sessions' satisfies CaxriMethod;

type DelegationFeed = MethodResult<'agent.delegation.sessions'>;

function feedCreatorIds(queryKey: readonly unknown[]): readonly string[] {
    const parameters = queryKey[1] as { createdBySessionIds?: readonly string[] } | undefined;
    return parameters?.createdBySessionIds ?? [];
}

/**
 * Refreshes the feed reads that cover the Sessions a `state.changed` push of kind `records` names.
 *
 * A delegation's state change (it started, finished, failed) reaches the Renderer as a record change of the Session it
 * runs in, never of the Session that created it, so the push carries no creator. The creator comes from `sessions`, the
 * Workbench records the Renderer already holds. A Session that is not among them yet may be a brand-new delegated
 * Session whose creator is not in any cached read, so it refreshes every feed read; a known Session with no creator is
 * not delegated and refreshes nothing, which is nearly every record push.
 */
function invalidateDelegationFeedForSessions(
    queryClient: QueryClient,
    sessionIds: readonly string[],
    sessions: ReadonlyArray<Pick<SessionRecord, 'createdBySessionId' | 'id'>>,
): void {
    if (sessionIds.length === 0) return;
    const isFeedQuery = (query: { queryKey: readonly unknown[] }): boolean =>
        isQueryMethod(query.queryKey, DELEGATION_FEED_METHOD);
    // Nearly every record push arrives while no nested row is mounted; skip the lookup then.
    if (queryClient.getQueryCache().findAll({ predicate: isFeedQuery }).length === 0) return;
    const creatorIds = new Set<string>();
    let isAnyUnknown = false;
    for (const sessionId of sessionIds) {
        const session = sessions.find((candidate) => candidate.id === sessionId);
        if (session === undefined) isAnyUnknown = true;
        else if (session.createdBySessionId !== undefined)
            creatorIds.add(session.createdBySessionId);
    }
    if (!isAnyUnknown && creatorIds.size === 0) return;
    // Fire-and-forget: the refreshed reads surface any error through React Query state.
    void queryClient.invalidateQueries({
        predicate: (query) =>
            isFeedQuery(query) &&
            (isAnyUnknown || feedCreatorIds(query.queryKey).some((id) => creatorIds.has(id))),
    });
}

/**
 * How long record pushes are gathered before the feed is refreshed. A running delegated Session pushes a record change
 * on nearly every step it takes, and one read covers all of them (the step itself is patched in place, so only a settle
 * or failure needs the read, and a second of lag on it is invisible); waiting also lets a brand-new Session reach the
 * Workbench records the creator lookup reads.
 */
const DELEGATION_FEED_COALESCE_MS = 1500;

export interface DelegationFeedInvalidation {
    dispose: () => void;
    /**
     * Notes the Sessions one `state.changed` push of kind `records` names.
     */
    invalidate: (sessionIds: readonly string[]) => void;
}

/**
 * Coalesces `state.changed` record pushes into one {@link invalidateDelegationFeedForSessions} pass per
 * {@link DELEGATION_FEED_COALESCE_MS}. `readSessions` is read when the window closes, not when a push arrives.
 */
export function createDelegationFeedInvalidation(
    queryClient: QueryClient,
    readSessions: () => ReadonlyArray<Pick<SessionRecord, 'createdBySessionId' | 'id'>>,
): DelegationFeedInvalidation {
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
        dispose: () => {
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
            pending.clear();
        },
        invalidate: (sessionIds) => {
            for (const sessionId of sessionIds) pending.add(sessionId);
            if (timer !== undefined || pending.size === 0) return;
            timer = setTimeout(() => {
                timer = undefined;
                const flushed = [...pending];
                pending.clear();
                invalidateDelegationFeedForSessions(queryClient, flushed, readSessions());
            }, DELEGATION_FEED_COALESCE_MS);
        },
    };
}

/**
 * Writes the step a running delegated Chat reports into the cached feed reads, instead of refetching: the hint fires as
 * often as the Agent changes what it is doing, and it names the Session and the task, so the cached entry can be
 * patched in place. An entry of a different task (`delegationId`) is left alone, because a later task replaced the one
 * that reported.
 */
export function applyDelegationProgress(
    queryClient: QueryClient,
    progress: AgentDelegationProgress,
): void {
    queryClient.setQueriesData<DelegationFeed>(
        { predicate: (query) => isQueryMethod(query.queryKey, DELEGATION_FEED_METHOD) },
        (feed) => {
            if (
                !feed?.sessions.some(
                    (entry) =>
                        entry.sessionId === progress.sessionId &&
                        entry.delegationId === progress.delegationId,
                )
            )
                return feed;
            return {
                ...feed,
                sessions: feed.sessions.map((entry) => {
                    if (
                        entry.sessionId !== progress.sessionId ||
                        entry.delegationId !== progress.delegationId
                    )
                        return entry;
                    const rest = omit(entry, ['step']);
                    return progress.step === undefined ? rest : { ...rest, step: progress.step };
                }),
            };
        },
    );
}
