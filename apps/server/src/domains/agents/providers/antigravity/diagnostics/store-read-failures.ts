import type { AntigravityStoreReadFailureReason, AntigravityStoreReadSite } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

export type { AntigravityStoreReadSite };

/**
 * One deduplicated report of a failing read of an Antigravity private store: the closed read site and reason, and how
 * many times that pair has failed in this process. Carries no path, error message, or content.
 */
export interface StoreReadFailureReport {
    site: AntigravityStoreReadSite;
    reason: AntigravityStoreReadFailureReason;
    count: number;
}

type Sink = (report: StoreReadFailureReport) => void;

const state: { sink: Sink | undefined } = { sink: undefined };
const counts = new Map<string, number>();

/**
 * Installs the process's diagnostics sink (Server Core wires its structured logger here). Without one, reports are
 * dropped, which is the case in the search Worker: its failures reach diagnostics as per-pass exclusion counts.
 */
export function setStoreReadFailureSink(next: Sink | undefined): void {
    state.sink = next;
    counts.clear();
}

/**
 * Routes the reports to `logger` at `warn` and returns the function that detaches it.
 */
export function logStoreReadFailures(logger: StructuredLogger): () => void {
    setStoreReadFailureSink(({ count, reason, site }) =>
        logger.write('warn', logEventCatalog.agent.antigravityStoreReadFailed, {
            fields: { count, reason, site },
        }),
    );
    return () => setStoreReadFailureSink(undefined);
}

/**
 * Records a failed read. A pair is reported on its first failure since the site last read successfully, then again at
 * each power-of-two count, so a stuck reader shows its real volume without one record per poll.
 */
export function reportStoreReadFailure(
    site: AntigravityStoreReadSite,
    reason: AntigravityStoreReadFailureReason,
): void {
    const key = `${site}:${reason}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);

    if (state.sink && (count & (count - 1)) === 0) state.sink({ site, reason, count });
}

/**
 * A successful read at `site` ends its failure streak, so the next failure is reported as a new transition.
 */
export function clearStoreReadFailure(site: AntigravityStoreReadSite): void {
    if (counts.size === 0) return;
    for (const key of counts.keys()) if (key.startsWith(`${site}:`)) counts.delete(key);
}
