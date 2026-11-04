import type {
    AgentDelegationProgress,
    CaxriMethod,
    DelegationQuestionChanged,
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

/**
 * The per-task states behind the records of a Chat timeline. They change with the same record pushes as the feed.
 */
const DELEGATION_STATUSES_METHOD = 'agent.delegation.statuses' satisfies CaxriMethod;

/**
 * The open question's text read behind the Session view's question card.
 */
const DELEGATION_QUESTION_DETAIL_METHOD = 'agent.delegation.questionDetail' satisfies CaxriMethod;

type DelegationFeed = MethodResult<'agent.delegation.sessions'>;
type DelegationStatuses = MethodResult<'agent.delegation.statuses'>;

function feedCreatorIds(queryKey: readonly unknown[]): readonly string[] {
    const parameters = queryKey[1] as { createdBySessionIds?: readonly string[] } | undefined;
    return parameters?.createdBySessionIds ?? [];
}

/**
 * Refreshes the feed reads that cover the Sessions a `state.changed` push of kind `records` names, and the task-state
 * reads that name a task running in one of them.
 *
 * A delegation's state change (it started, finished, failed) reaches the Renderer as a record change of the Session it
 * runs in, never of the Session that created it, so the push carries no creator. The creator comes from `sessions`, the
 * Workbench records the Renderer already holds. A Session that is not among them yet may be a brand-new delegated
 * Session whose creator is not in any cached read, so it refreshes every feed read; a known Session with no creator is
 * not delegated and refreshes nothing, which is nearly every record push. A task-state read is keyed by task IDs, so it
 * is matched by the Sessions its cached answer names; one with no answer yet is refreshed.
 */
function invalidateDelegationFeedForSessions(
    queryClient: QueryClient,
    sessionIds: readonly string[],
    sessions: ReadonlyArray<Pick<SessionRecord, 'createdBySessionId' | 'id'>>,
): void {
    if (sessionIds.length === 0) return;
    const isFeedQuery = (query: { queryKey: readonly unknown[] }): boolean =>
        isQueryMethod(query.queryKey, DELEGATION_FEED_METHOD);
    const isStatusesQuery = (query: { queryKey: readonly unknown[] }): boolean =>
        isQueryMethod(query.queryKey, DELEGATION_STATUSES_METHOD);
    // Nearly every record push arrives while no nested row is mounted; skip the lookup then.
    if (
        queryClient.getQueryCache().findAll({
            predicate: (query) => isFeedQuery(query) || isStatusesQuery(query),
        }).length === 0
    )
        return;
    const creatorIds = new Set<string>();
    const changedIds = new Set(sessionIds);
    let isAnyUnknown = false;
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    for (const sessionId of sessionIds) {
        const session = sessionById.get(sessionId);
        if (session === undefined) isAnyUnknown = true;
        else if (session.createdBySessionId !== undefined)
            creatorIds.add(session.createdBySessionId);
    }
    // Fire-and-forget: the refreshed reads surface any error through React Query state.
    void queryClient.invalidateQueries({
        predicate: (query) => {
            if (isFeedQuery(query))
                return (
                    isAnyUnknown || feedCreatorIds(query.queryKey).some((id) => creatorIds.has(id))
                );
            if (!isStatusesQuery(query)) return false;
            const answer = query.state.data as DelegationStatuses | undefined;
            return (
                isAnyUnknown ||
                answer === undefined ||
                answer.statuses.some((status) => changedIds.has(status.sessionId))
            );
        },
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

/**
 * Re-reads what a question's change moved: every Delegated Sessions feed read (the row asks, escalates, or stops
 * asking) and the question's detail read of that task. The event carries ids and closed values only, so nothing is
 * patched in: the text arrives through the owner-only `questionDetail` read, and only when a question card asks.
 */
export function invalidateDelegationQuestion(
    queryClient: QueryClient,
    change: Pick<DelegationQuestionChanged, 'delegationId'>,
): void {
    void queryClient.invalidateQueries({
        predicate: (query) => {
            if (isQueryMethod(query.queryKey, DELEGATION_FEED_METHOD)) return true;
            if (!isQueryMethod(query.queryKey, DELEGATION_QUESTION_DETAIL_METHOD)) return false;
            const parameters = query.queryKey[1] as { delegationId?: string } | undefined;
            return parameters?.delegationId === change.delegationId;
        },
    });
}
