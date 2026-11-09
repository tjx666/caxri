import type { AgentChatDefaultsProvider } from '@caxri/protocol';

import { translate } from '../../../i18n';
import { caxri } from '../../../lib/caxri';
import { caxriQueryKey, queryClient } from '../../../queries/client';
import { tryCommand } from '../../../stores/toasts';

/**
 * Writes an Agent's global model default to its own config file and caches the defaults it answers with, so the form
 * shows the saved value without another read. A failure toasts and leaves the cached reading as it was.
 */
export async function writeChatDefaults(
    provider: AgentChatDefaultsProvider,
    change: { model?: string | null; effort?: string | null; ultracode?: boolean | null },
): Promise<void> {
    await tryCommand(translate('settings.chatDefaults.saveFailed'), async () => {
        const defaults = await caxri.request('agentChat.writeDefaults', { provider, ...change });
        queryClient.setQueryData(caxriQueryKey('agentChat.readDefaults', { provider }), defaults);
    });
}
