import type { CommanderAgent, CommanderClearData } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { pushToast, tryCommand } from '../../stores/toasts';
import { commanderClearDataOutcome } from './commander-clear-data';
import { closeCommanderClearData, useCommanderDialogsStore } from './commander-dialogs-store';

export function commanderAgentName(agent: CommanderAgent): string {
    return agentProviderCatalog[agent].displayName;
}

/**
 * Moves the Commander to another Agent CLI once the user confirms. The switch keeps the Commander's Terminal, so every
 * task it delegated stays its own, and its workspace, so the new Agent reads the same instructions and memory. Only the
 * conversation starts over, and the question says exactly that. It is not destructive, so it takes the in-app
 * confirmation rather than the native one.
 */
export async function switchCommanderAgent(
    current: CommanderAgent | undefined,
    next: CommanderAgent,
): Promise<void> {
    if (current === next) return;
    const agent = commanderAgentName(next);
    const isConfirmed = await caxri.window.showConfirm({
        title: translate('agentCommander.agent.switchTitle', { agent }),
        message: translate('agentCommander.agent.switchMessage', { agent }),
        confirmLabel: translate('agentCommander.agent.switchConfirm', { agent }),
    });
    if (!isConfirmed) return;
    await tryCommand(translate('agentCommander.agent.switchFailed', { agent }), () =>
        caxri.request('commander.switchAgent', { agent: next }),
    );
}

/**
 * Desktop Main asks the native destructive confirmation before anything is cleared. A cancel there leaves the dialog
 * open with its selection, so the user can adjust it; a success closes it and names what went. Closing the dialog while
 * a clear runs does not stop it. The board and the Inbox refresh from the Server's own change events.
 */
export async function clearCommanderData(request: CommanderClearData): Promise<void> {
    const { clearDataRequestId } = useCommanderDialogsStore.getState();
    const result = await tryCommand(translate('agentCommander.clearData.failed'), () =>
        caxri.request('agentCommander.clearData', request),
    );
    if (!result || 'canceled' in result) return;
    closeCommanderClearData(clearDataRequestId);
    pushToast('success', commanderClearDataOutcome(result, translate));
}
