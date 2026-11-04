import { useEffect, useRef } from 'react';

import type { DelegationCostSummary } from '@caxri/protocol';

import { useCaxriQuery } from '../../../../queries/client';
import { COST_SCAN_POLL_MS, costRefetchInterval } from '../cost/agent-chat-delegated-cost';

/**
 * What the Sessions this Chat delegated to have cost, read from `usage.delegationSummary` for the visible strip.
 *
 * Freshness has two parts. A feed change (a task started, settled, or failed) invalidates this read with the feed's own
 * record-push invalidation, so a settle shows its cost without polling, and a running task needs no timer. The usage
 * ledger fills after a task settles, so while the Server reports `isScanPending` the read repeats on a short interval
 * for a bounded number of completed reads until the scan lands (`costRefetchInterval`). A finished, scanned summary is
 * never polled, and neither is a strip that is not mounted. A failed read returns `undefined` rather than the figure it
 * last had, because a stale amount after an error reads as current, and stops the poll.
 */
export function useDelegatedCost(
    sessionId: string | undefined,
    isEnabled: boolean,
): DelegationCostSummary | undefined {
    /**
     * Completed reads since the scan became pending. Written only by effects, so `refetchInterval` stays a pure read.
     */
    const pendingFetches = useRef(0);
    const { data, dataUpdatedAt, isError } = useCaxriQuery(
        'usage.delegationSummary',
        { sessionId: sessionId ?? '' },
        {
            enabled: isEnabled && sessionId !== undefined,
            // A failed read stops the pending-scan poll: `dataUpdatedAt` does not move on an error, so the
            // completed-read budget would never run out. The next feed invalidation reads again.
            refetchInterval: (query) =>
                query.state.status === 'error'
                    ? false
                    : costRefetchInterval(query.state.data, pendingFetches.current),
            staleTime: COST_SCAN_POLL_MS,
        },
    );
    useEffect(() => {
        pendingFetches.current = 0;
    }, [sessionId]);
    const isScanPending = data?.isScanPending === true;
    useEffect(() => {
        pendingFetches.current = isScanPending ? pendingFetches.current + 1 : 0;
    }, [dataUpdatedAt, isScanPending]);
    return isError ? undefined : data;
}
