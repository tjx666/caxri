import type { ServerEvent } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import { translate } from '../../i18n';
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
            translate('terminal.outputRecovery.recovered', { provider: providerName }),
            {
                type: 'agent-recovery',
                action: { id: 'settings.open' },
            },
        );
    else
        pushToast(
            'error',
            translate('terminal.outputRecovery.paused', { provider: providerName }),
            { action: { id: 'settings.open' } },
        );
}
