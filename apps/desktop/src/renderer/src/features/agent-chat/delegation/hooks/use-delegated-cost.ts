import { useRef } from 'react';

import type { DelegationCostSummary } from '@caxri/protocol';

import { useCaxriQuery } from '../../../../queries/client';
import {
    COST_ACTIVE_POLL_MS,
    COST_SCAN_POLL_LIMIT,
    COST_SCAN_POLL_MS,
} from '../cost/agent-chat-delegated-cost';

/**
 * What the Sessions this Chat delegated to have cost, read from `usage.delegationSummary` for the visible strip.
 *
 * Freshness has two parts. A feed change (a task started, settled, or failed) invalidates this read with the feed's own
 * record-push invalidation, so a settle shows its cost without polling. The usage ledger fills after a task settles, so
 * while the Server reports `isScanPending` the read repeats on a short, bounded interval until the scan lands; while a
 * descendant still runs the figure is `~` and refreshes on a slow one. Neither runs for a strip that is not mounted,
 * and a finished, scanned summary is never polled.
 */
export function useDelegatedCost(
    sessionId: string | undefined,
    isEnabled: boolean,
): DelegationCostSummary | undefined {
    const pendingPolls = useRef(0);
    const { data } = useCaxriQuery(
        'usage.delegationSummary',
        { sessionId: sessionId ?? '' },
        {
            enabled: isEnabled && sessionId !== undefined,
            refetchInterval: (query) => {
                const summary = query.state.data;
                if (!summary?.isScanPending) {
                    pendingPolls.current = 0;
                    return summary?.isActive ? COST_ACTIVE_POLL_MS : false;
                }
                pendingPolls.current += 1;
                return pendingPolls.current <= COST_SCAN_POLL_LIMIT ? COST_SCAN_POLL_MS : false;
            },
            staleTime: COST_SCAN_POLL_MS,
        },
    );
    return data;
}
