import type { BotAgent, BotClearData } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { pushToast, tryCommand } from '../../stores/toasts';
import { botClearDataOutcome } from './bot-clear-data';
import { closeBotClearData, useBotDialogsStore } from './bot-dialogs-store';

export function botAgentName(agent: BotAgent): string {
    return agentProviderCatalog[agent].displayName;
}

/**
 * Moves Caxri Bot to another Agent CLI once the user confirms. The switch keeps Caxri Bot's Terminal, so every task it
 * delegated stays its own, and its workspace, so the new Agent reads the same instructions and memory. Only the
 * conversation starts over, and the question says exactly that. It is not destructive, so it takes the in-app
 * confirmation rather than the native one.
 */
export async function switchBotAgent(current: BotAgent | undefined, next: BotAgent): Promise<void> {
    if (current === next) return;
    const agent = botAgentName(next);
    const isConfirmed = await caxri.window.showConfirm({
        title: translate('caxriBot.agent.switchTitle', { agent }),
        message: translate('caxriBot.agent.switchMessage', { agent }),
        confirmLabel: translate('caxriBot.agent.switchConfirm', { agent }),
    });
    if (!isConfirmed) return;
    await tryCommand(translate('caxriBot.agent.switchFailed', { agent }), () =>
        caxri.request('bot.switchAgent', { agent: next }),
    );
}

/**
 * Desktop Main asks the native destructive confirmation before anything is cleared. A cancel there leaves the dialog
 * open with its selection, so the user can adjust it; a success closes it and names what went. Closing the dialog while
 * a clear runs does not stop it. The board and the Inbox refresh from the Server's own change events.
 */
export async function clearBotData(request: BotClearData): Promise<void> {
    const { clearDataRequestId } = useBotDialogsStore.getState();
    const result = await tryCommand(translate('caxriBot.clearData.failed'), () =>
        caxri.request('caxriBot.clearData', request),
    );
    if (!result || 'canceled' in result) return;
    closeBotClearData(clearDataRequestId);
    pushToast('success', botClearDataOutcome(result, translate));
}
