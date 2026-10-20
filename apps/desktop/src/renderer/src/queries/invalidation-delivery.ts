import type { CaxriMethod } from '@caxri/protocol';
import type { QueryClient } from '@tanstack/react-query';

import { isQueryMethod } from './client';

/**
 * Invalidations for the delivery status reads (Project Status summary and overview, the shared pull-request list),
 * split out of `invalidation.ts`, which dispatches to them from its event subscription.
 */

/**
 * Query-key prefix for the shared pull-request sidebar read. Annotated rather than inferred so a renamed method is a
 * compile error here, instead of a predicate that quietly stops matching anything.
 */
export const PULL_REQUESTS_QUERY_KEY: readonly [CaxriMethod] = ['session.pullRequests'];

/**
 * Invalidates both Project Status reads for one Session after `projectStatus.changed`: the Status panel's
 * `projectStatus.summary` and the status bar's `projectStatus.overview`. The two reads are computed independently, but
 * a summary refresh warms the same shared `GitHubPullRequestStore`/`LinearIssueStore`/`AcceptanceStore` records the
 * overview reads from (see `ProjectStatusService` in `apps/server/src/domains/project-status/index.ts`), so this
 * refetch normally costs no extra delivery-CLI call. This is what lets the status bar converge with the Status panel in
 * the same Server refresh instead of waiting out its own poll (issue caxri#1310).
 */
export function invalidateProjectStatusQuery(queryClient: QueryClient, sessionId: string): void {
    // Fire-and-forget: the refreshed query surfaces any error through React Query state.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [, parameters] = query.queryKey as [
                CaxriMethod,
                { sessionId?: string } | undefined,
            ];
            return (
                isQueryMethod(query.queryKey, 'projectStatus.summary', 'projectStatus.overview') &&
                parameters?.sessionId === sessionId
            );
        },
    });
}

/**
 * Invalidates the shared `session.pullRequests` sidebar query and the affected Sessions' `projectStatus.overview` read
 * after `sessionPullRequests.changed`. `SessionPullRequestService` and `ProjectStatusService` share one
 * `GitHubPullRequestStore` (see `service-handlers.ts`), so the overview's own pull-request resolution normally answers
 * from the record this sweep just wrote rather than paying for another `gh pr view` (issue caxri#1310).
 */
export function invalidateSessionPullRequestDependentQueries(
    queryClient: QueryClient,
    sessionIds: readonly string[],
): void {
    // Fire-and-forget: the refreshed query surfaces any error through React Query state.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({ queryKey: PULL_REQUESTS_QUERY_KEY });
    // A pull request changing state (merged in Caxri or elsewhere) also moves the icon and text of every transcript link
    // and tracker card that previews it; only mounted readers refetch, and the Server's reference cache is short for an
    // open pull request.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        queryKey: ['terminal.reference.preview' satisfies CaxriMethod],
    });
    const sessionIdSet = new Set(sessionIds);
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        predicate: (query) => {
            const [, parameters] = query.queryKey as [
                CaxriMethod,
                { sessionId?: string } | undefined,
            ];
            return (
                isQueryMethod(query.queryKey, 'projectStatus.overview') &&
                parameters?.sessionId !== undefined &&
                sessionIdSet.has(parameters.sessionId)
            );
        },
    });
}

/**
 * Re-asks the Server for delivery status after a settings write. `projectStatus.ignoredChecks` decides which checks the
 * Status panel rollup and the sidebar CI badge aggregate, and both are served from Server-side caches that survive for
 * minutes, so an edit would otherwise keep showing the pre-change rollup. The Server compares the rules before spending
 * anything, so a settings write that leaves them alone answers from cache.
 */
export function invalidateDeliveryStatusQueries(queryClient: QueryClient): void {
    // Fire-and-forget: the refreshed queries surface any error through React Query state.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void queryClient.invalidateQueries({
        predicate: (query) => {
            return isQueryMethod(query.queryKey, 'projectStatus.summary', 'session.pullRequests');
        },
    });
}
