import type { AgentProvider, AgentUsageReadout } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { caxriQueryKey, queryClient } from '../../queries/client';

/**
 * Hides the provider's pace reminder, and the status bar chip's pace warning, for the rest of the local day. The Server
 * keeps the dismissal (`usage.dismissPlanPace`), so a restart, another window, or a paired phone does not bring it
 * back; the Terminal's cached readout takes the dismissal at once so the row disappears before the next 2-second poll,
 * and a failed request leaves that poll to bring the reminder back.
 */
export async function dismissPlanPace(terminalId: string, provider: AgentProvider): Promise<void> {
    const queryKey = caxriQueryKey('terminal.agentUsage', { terminalId });
    // A poll already in flight would otherwise land a pre-dismissal readout and flash the row back.
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData<AgentUsageReadout | null>(queryKey, (readout) =>
        readout?.limit
            ? { ...readout, limit: { ...readout.limit, paceDismissedAt: Date.now() } }
            : readout,
    );
    try {
        await caxri.request('usage.dismissPlanPace', { provider });
    } catch {
        // The next poll reads the Server's answer and shows the reminder again.
    }
}
