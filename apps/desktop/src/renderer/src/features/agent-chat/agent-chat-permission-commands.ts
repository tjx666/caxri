import type { AgentChatPermissionRequest } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';

/**
 * Switches the Chat's permission level or plan mode. Resolves `true` once Server Core accepted the switch, so the
 * picker can keep showing the choice as pending until the projection reports it and drop it when the switch failed.
 * Grok Build restarts on the same conversation to apply a level, and refuses while a turn runs; the toast reports
 * that.
 */
export async function didConfigureAgentChatPermission(
    terminalId: string,
    change: AgentChatPermissionRequest,
): Promise<boolean> {
    let isConfigured = false;
    await tryCommand(translate('agentChat.permission.changeFailed'), async () => {
        await caxri.request('agentChat.configure', { terminalId, ...change });
        isConfigured = true;
    });
    return isConfigured;
}
