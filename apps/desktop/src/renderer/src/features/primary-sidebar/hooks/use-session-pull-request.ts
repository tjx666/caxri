import { usePolledQuery } from '../../../hooks/use-polled-query';
import { useCaxriQuery } from '../../../queries/client';
import { SESSION_PULL_REQUESTS_REFETCH_INTERVAL_MS } from '../../session/session-commands';
import type { SessionPullRequestSlice } from '../session-pull-request';
import { NO_SESSION_PULL_REQUEST, selectSessionPullRequest } from '../session-pull-request';

/**
 * Keeps the shared `session.pullRequests` snapshot fresh without subscribing the caller to it.
 *
 * The poll belongs above the rows (one request per tick, not one per Session) but the snapshot it refreshes carries a
 * `refreshedAt` timestamp that the Server moves whenever a sweep completes, so a tick that found nothing new still
 * publishes a value that differs from the last one. An owner that also read that value would repaint the whole sidebar
 * once a minute for data nobody changed; `notifyOnChangeProps: []` keeps the interval here and leaves the reading to
 * the rows.
 */
export function useSessionPullRequestPoll(): void {
    usePolledQuery('session.pullRequests', undefined, {
        intervalMs: SESSION_PULL_REQUESTS_REFETCH_INTERVAL_MS,
        label: 'session.pullRequests',
        notifyOnChangeProps: [],
    });
}

/**
 * One Session row's pull-request state.
 *
 * Shares the cache entry {@link useSessionPullRequestPoll} refreshes: same query key, so a row adds an observer rather
 * than a request. `select` narrows what the row is subscribed to, so it re-renders when its own pull request changes
 * and stays quiet through every poll that changes somebody else's, or nobody's.
 *
 * Rows mount and unmount far more often than the cadence they read: collapsing a Project group unmounts every row
 * inside it, and expanding it mounts them all again. Reading on the default freshness policy would make each of those
 * mounts refetch, and a read the Server considers expired starts a `gh` sweep, so a group the user opened twice would
 * pull that sweep forward off the poll's own tick. The cadence is {@link useSessionPullRequestPoll}'s alone; a row only
 * ever reads what that poll last put in the cache. This matches the palette's read of the same key.
 */
export function useSessionPullRequest(sessionId: string): SessionPullRequestSlice {
    return (
        useCaxriQuery('session.pullRequests', undefined, {
            refetchOnMount: false,
            select: (snapshot) => selectSessionPullRequest(snapshot, sessionId),
            staleTime: SESSION_PULL_REQUESTS_REFETCH_INTERVAL_MS,
        }).data ?? NO_SESSION_PULL_REQUEST
    );
}
