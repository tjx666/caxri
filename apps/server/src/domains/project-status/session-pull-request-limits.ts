/**
 * Cache lifetimes, concurrency, and query bounds for the Session pull-request service.
 */
/**
 * Merge state moves on human timescales, so an open PR refreshes once a minute while a merged or closed one only
 * re-confirms every fifteen minutes. A branch with no PR is re-queried every five minutes: the Agent usually opens the
 * PR from inside its own transcript, which the cheap local scan catches on the next sweep without any `gh` call.
 */
export const OPEN_TTL_MS = 60_000;
export const SETTLED_TTL_MS = 15 * 60_000;
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
