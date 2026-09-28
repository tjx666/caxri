import type { ServerEvent } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import { pushToast } from '../../stores/toasts';

/**
 * Tells the user what automatic Agent output recovery just did: one matched rule sent Esc and continue, or the retry
 * budget ran out and recovery paused. Both offer Settings, where the recovery rules live.
 */
export function reportTerminalOutputRecovery(
    payload: Extract<ServerEvent, { event: 'terminal.outputRecovery' }>['payload'],
): void {
    const providerName = agentProviderCatalog[payload.provider].displayName;
    if (payload.status === 'recovered')
        pushToast(
            'success',
            `Sent Esc and continue to ${providerName} after a matched recovery rule.`,
            {
                type: 'agent-recovery',
                action: { id: 'settings.open' },
            },
        );
    else
        pushToast(
            'error',
            `Automatic recovery paused for ${providerName} after 3 attempts in 10 minutes.`,
            { action: { id: 'settings.open' } },
        );
}
