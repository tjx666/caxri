import type { SessionDiffStat } from '@caxri/protocol';

import { usePolledQuery } from '../../../hooks/use-polled-query';
import { diffStatLabel } from '../../../lib/diff-stat-label';
import { useCaxriQuery } from '../../../queries/client';

/**
 * How often the sidebar asks for fresh diff stats while the window is visible. Only the selected Session's root has a
 * file watcher behind it, so this cadence is what keeps every other row's count honest; `git.changed` refetches early
 * whenever a watched root or a `.git` metadata change announces itself.
 */
const SESSION_DIFF_STATS_REFETCH_INTERVAL_MS = 30_000;

/**
 * Keeps the shared `session.diffStats` snapshot fresh without subscribing the caller to it, the same split as
 * `useSessionPullRequestPoll`: one request per tick above the rows, and `notifyOnChangeProps: []` so the owner never
 * repaints the sidebar for a snapshot only the rows read.
 */
export function useSessionDiffStatPoll(): void {
    usePolledQuery('session.diffStats', undefined, {
        intervalMs: SESSION_DIFF_STATS_REFETCH_INTERVAL_MS,
        label: 'session.diffStats',
        notifyOnChangeProps: [],
    });
}

/**
 * One Session row's diff stat from the snapshot {@link useSessionDiffStatPoll} refreshes. `select` narrows the
 * subscription to this Session, and `refetchOnMount: false` leaves the cadence to the poll so expanding a Project group
 * never pulls a Git sweep forward. `undefined` when the root is not a repository or has no changes.
 */
export function useSessionDiffStat(sessionId: string): SessionDiffStat | undefined {
    return useCaxriQuery('session.diffStats', undefined, {
        refetchOnMount: false,
        select: (snapshot) => {
            if (!Object.hasOwn(snapshot.stats, sessionId)) return;
            const stat = snapshot.stats[sessionId];
            return stat.additions > 0 || stat.deletions > 0 ? stat : undefined;
        },
        staleTime: SESSION_DIFF_STATS_REFETCH_INTERVAL_MS,
    }).data;
}

/**
 * The row's `+N -M` in words for its accessible description, where bare signed digits would read as arithmetic.
 */
export function sessionDiffStatAriaLabel(stat: SessionDiffStat | undefined): string | undefined {
    if (!stat) return undefined;
    return `Branch changes: ${diffStatLabel(stat)}.`;
}
