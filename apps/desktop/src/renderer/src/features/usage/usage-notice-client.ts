import type { AgentProvider, AgentUsageReadout, UsageLimit, UsageNotice } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { caxriQueryKey, queryClient } from '../../queries/client';

/**
 * Where each notice's dismissal lands on the reading.
 */
const DISMISSED_AT = {
    planPace: 'paceDismissedAt',
    credits: 'creditsNoticeDismissedAt',
} as const satisfies Record<UsageNotice, keyof UsageLimit>;

/**
 * Hides one of the provider's plan notices: the pace reminder (with the status bar chip's pace warning) for the rest of
 * the local day, the credits notice for a day. The Server keeps the dismissal, so a restart, another window, or a
 * paired phone does not bring it back; the Terminal's cached readout takes the dismissal at once so the row disappears
 * before the next 2-second poll, and a failed request leaves that poll to bring the notice back.
 */
export async function dismissUsageNotice(
    terminalId: string,
    provider: AgentProvider,
    notice: UsageNotice,
): Promise<void> {
    const field = DISMISSED_AT[notice];
    const queryKey = caxriQueryKey('terminal.agentUsage', { terminalId });
    // A poll already in flight would otherwise land a pre-dismissal readout and flash the row back.
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData<AgentUsageReadout | null>(queryKey, (readout) =>
        readout?.limit ? { ...readout, limit: { ...readout.limit, [field]: Date.now() } } : readout,
    );
    try {
        await caxri.request('usage.dismissNotice', { provider, notice });
    } catch {
        // The next poll reads the Server's answer and shows the notice again.
    }
}
