import type { AgentChatModelRequest } from '@caxri/protocol';

import { translate } from '../../../i18n';
import { caxri } from '../../../lib/caxri';
import { tryCommand } from '../../../stores/toasts';
import { agentChatConfigureFailureMessage } from './agent-chat-model-selection';

/**
 * Switches the model or effort for the next turn onward. Resolves `true` once Server Core accepted the switch; the
 * picker shows the choice as pending until the projection reports it, and drops it when the switch failed. The failure
 * toast names what was being switched.
 */
export async function didConfigureAgentChat(
    terminalId: string,
    change: AgentChatModelRequest,
): Promise<boolean> {
    let isConfigured = false;
    await tryCommand(agentChatConfigureFailureMessage(change), async () => {
        await caxri.request('agentChat.configure', { terminalId, ...change });
        isConfigured = true;
    });
    return isConfigured;
}

/**
 * Drops the Chat's own model, effort, ultracode, and Fast mode choice so it runs the global default again: the launch
 * arguments, then the Agent's own config file (Settings › Agents › Default model). The snapshot reports the result.
 */
export async function resetAgentChatChoice(terminalId: string): Promise<void> {
    await tryCommand(translate('agentChat.model.resetChoiceFailed'), () =>
        caxri.request('agentChat.configure', { terminalId, resetChoice: true }),
    );
}
