import type { ProjectStatusSummary } from '@caxri/protocol';

import type { ProjectStatusServiceOptions } from './options';
import { isInFlight } from './watch';

/**
 * Cache lifetime adapts to what the snapshot contains, because that is also what paces the resident poller in
 * `./index.ts`. A running CI job or an in-flight deployment changes on a scale of tens of seconds and is exactly when
 * the user wants to see movement; a settled pull request will not change until someone pushes, so re-asking every
 * minute only spends the shared `gh`/`vc` budget the limiter is trying to protect.
 */
const SUMMARY_PENDING_CACHE_TTL_MS = 20_000;
const SUMMARY_SETTLED_CACHE_TTL_MS = 120_000;
/**
 * A failed refresh must back off _further_ than a successful one, never less. The previous 30s retried a rate-limited
 * `gh` twice as often as a healthy one, which is how a transient limit turned into a sustained one.
 */
const SUMMARY_FAILURE_CACHE_TTL_MS = 5 * 60_000;

/**
 * How long this snapshot stays authoritative. An explicit `cacheTtlMs` (tests, and callers that need a fixed window)
 * wins; otherwise the presence of anything still running decides.
 */
export function summaryCacheTtlMs(
    summary: ProjectStatusSummary,
    hasFailures: boolean,
    options: Pick<ProjectStatusServiceOptions, 'cacheTtlMs' | 'failureCacheTtlMs'>,
): number {
    if (hasFailures) return options.failureCacheTtlMs ?? SUMMARY_FAILURE_CACHE_TTL_MS;
    if (options.cacheTtlMs !== undefined) return options.cacheTtlMs;
    /*
     * `queued` counts as in flight. A queued run is the state most likely to be stale a second later: it is
     * waiting for a runner, and the transition to `pending` is the one thing the split between the two states
     * exists to show. Holding it for the settled window would report "not started" for up to two minutes after it
     * started, and for a repository reporting through commit statuses rather than check runs, for the whole run.
     */
    return isInFlight(summary) ? SUMMARY_PENDING_CACHE_TTL_MS : SUMMARY_SETTLED_CACHE_TTL_MS;
}
