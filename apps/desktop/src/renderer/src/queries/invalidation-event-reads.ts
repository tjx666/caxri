import type { CaxriMethod } from '@caxri/protocol';
import type { QueryClient } from '@tanstack/react-query';

import { isQueryMethod } from './client';

/**
 * Invalidations for Server events that each name exactly one read, split out of `invalidation.ts`, which keeps the
 * multi-read sweeps (files, Git, delivery status, Session removal) and the event subscription that dispatches here.
 */

/**
 * The Commander Inbox, read by the status bar's "Needs you" chip. `commanderInbox.changed` names item IDs, but the chip
 * counts the whole list, so the event invalidates every cached list read.
 */
const COMMANDER_INBOX_QUERY_KEY: readonly [CaxriMethod] = ['commander.inbox.list'];
/**
 * Every repository's pending review comment count, across every Session; no arguments, so one invalidation covers every
 * mounted reader (the quit reminder, "Show Pending Review Comments") the same way `PULL_REQUESTS_QUERY_KEY` does.
 */
const GIT_REVIEW_PENDING_QUERY_KEY: readonly [CaxriMethod] = ['gitReview.pending'];

/**
 * Refreshes one Session's "Always allow in this Session" read (issue caxri#1295) after its own
 * `agent.permissionAutoAllowChanged` transition, so the Session row menu shows the current grant whether it changed
 * from this window, another window, or a mobile device.
 */
export function invalidatePermissionAutoAllowQuery(
    queryClient: QueryClient,
    sessionId: string,
): void {
    // Fire-and-forget: the refreshed query surfaces any error through React Query state.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [, parameters] = query.queryKey as [
                CaxriMethod,
                { sessionId?: string } | undefined,
            ];
            return (
                isQueryMethod(query.queryKey, 'session.permissionAutoAllowStatus') &&
                parameters?.sessionId === sessionId
            );
        },
    });
}

/**
 * Refreshes the review comments for one Session + repository, and the cross-repository pending summary, after their own
 * `gitReview.changed` event: the Monaco bindings (`git-review-comment-binding.ts`) and the pending-comments
 * command/quit reminder both read through React Query rather than owning any comment state themselves.
 */
export function invalidateGitReviewQueries(
    queryClient: QueryClient,
    sessionId: string,
    repoId: string,
): void {
    // Fire-and-forget: the refreshed queries surface any error through React Query state.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [, parameters] = query.queryKey as [
                CaxriMethod,
                { repositoryId?: string; sessionId?: string } | undefined,
            ];
            return (
                isQueryMethod(query.queryKey, 'gitReview.list') &&
                parameters?.sessionId === sessionId &&
                parameters.repositoryId === repoId
            );
        },
    });
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({ queryKey: GIT_REVIEW_PENDING_QUERY_KEY });
}

/**
 * Refreshes the Commander Inbox read behind the status bar's "Needs you" chip after `commanderInbox.changed`, whichever
 * window or device changed it.
 */
export function invalidateCommanderInboxQuery(queryClient: QueryClient): void {
    // eslint-disable-next-line no-void -- React Query owns the invalidation lifecycle
    void queryClient.invalidateQueries({ queryKey: COMMANDER_INBOX_QUERY_KEY });
}
