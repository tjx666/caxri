import type { SessionPullRequest, SessionRecord } from '@caxri/protocol';

import { isSettled } from './session-pull-request-entries';
import { isDormantSession } from './watch';

/**
 * Cache lifetimes, concurrency, and query bounds for the Session pull-request service.
 */
/**
 * Merge state moves on human timescales, so an open PR refreshes once a minute while a merged or closed one only
 * re-confirms every fifteen minutes. A branch with no PR is re-queried every five minutes: the Agent usually opens the
 * PR from inside its own transcript, which the cheap local scan catches on the next sweep without any `gh` call.
 */
export const OPEN_TTL_MS = 60_000;
const SETTLED_TTL_MS = 15 * 60_000;
export const MISSING_TTL_MS = 5 * 60_000;
/**
 * A failed lookup retries on the status-bar's minute cadence so recovery clears the unknown state automatically.
 * Rate-limited calls still use the source-level circuit breaker to avoid wasteful requests.
 */
export const FAILURE_TTL_MS = 60_000;
export const MAX_CONCURRENT_LOOKUPS = 4;
/**
 * How old a shared pull-request record a forced Session refresh still accepts. The focus refresh re-reads the Status
 * panel first, which refetches the same pull request moments earlier; accepting that record avoids paying a second `gh
 * pr view` for it while still rejecting anything fetched before the window regained focus.
 */
export const FORCED_RECORD_MAX_AGE_MS = 5_000;
export const MAX_PULL_REQUEST_ENTRIES = 256;
/**
 * Integration branches never carry the Session's own delivery, and querying them would cost a `gh` call per sweep.
 */
export const INTEGRATION_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk', 'HEAD']);
/**
 * Branch discovery only has to answer "which pull request is this branch's?", so it asks for identity and nothing else.
 * `statusCheckRollup` here used to multiply the query's GraphQL cost by every candidate returned; the selected pull
 * request's checks now come from the shared record, which the Status panel and status bar read too.
 */
export const BRANCH_DISCOVERY_JSON_FIELDS = 'number,state,isDraft';
/**
 * Enough candidates to rank an open pull request above a merged and a closed one for the same branch, without paying
 * for a page of history nobody renders.
 */
export const MAX_BRANCH_CANDIDATES = '5';

/**
 * Overrides tests pass to {@link pullRequestTtlMs}; production uses the constants above.
 */
export interface PullRequestTtlOverrides {
    openTtlMs?: number;
    settledTtlMs?: number;
    missingTtlMs?: number;
}

/**
 * How long one resolved projection stays fresh: open, settled (merged or closed), or no pull request at all.
 */
export function pullRequestTtlMs(
    value: SessionPullRequest | undefined,
    overrides: PullRequestTtlOverrides,
): number {
    if (!value) return overrides.missingTtlMs ?? MISSING_TTL_MS;
    return isSettled(value)
        ? (overrides.settledTtlMs ?? SETTLED_TTL_MS)
        : (overrides.openTtlMs ?? OPEN_TTL_MS);
}

/**
 * How often the sidebar sweep re-confirms a dormant Session's pull request: often enough that a merge done elsewhere
 * still lands on its row the same hour, rare enough that hundreds of old rows cost tens of queries an hour, not
 * thousands.
 */
const DORMANT_SWEEP_INTERVAL_MS = 60 * 60_000;

/**
 * Picks the Sessions a sidebar pull-request sweep resolves. An active Session is always due and its entries' own TTLs
 * decide whether that costs a query. A dormant Session is resolved at most once per {@link DORMANT_SWEEP_INTERVAL_MS},
 * whatever those TTLs say, provided `isDeferrable` vouches for its last projection (it has one, it is not a failure,
 * and nobody forced a refresh).
 */
export class DormantSweeps {
    private readonly sweptAt = new Map<string, number>();

    select<
        T extends Pick<SessionRecord, 'createdAt' | 'id' | 'lastVisitedAt' | 'sessionActivityAt'>,
    >(sessions: readonly T[], now: number, isDeferrable: (session: T) => boolean): T[] {
        const liveIds = new Set(sessions.map((session) => session.id));
        for (const sessionId of this.sweptAt.keys())
            if (!liveIds.has(sessionId)) this.sweptAt.delete(sessionId);
        return sessions.filter((session) => {
            if (!isDormantSession(session, now)) {
                this.sweptAt.delete(session.id);
                return true;
            }
            const sweptAt = this.sweptAt.get(session.id);
            if (
                sweptAt !== undefined &&
                now - sweptAt < DORMANT_SWEEP_INTERVAL_MS &&
                isDeferrable(session)
            )
                return false;
            this.sweptAt.set(session.id, now);
            return true;
        });
    }

    /**
     * Makes every dormant Session due on the next sweep, for a change (such as new ignored-check rules) that
     * invalidates every projection at once.
     */
    clear(): void {
        this.sweptAt.clear();
    }
}
