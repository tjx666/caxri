import { useState } from 'react';

import { showToast } from '../../../components/toast-store';
import { useTranslation } from '../../../i18n';
import type { AgentChatController } from '../use-agent-chat';

/**
 * The context notice's Compact button: runs the provider's `/compact` the way choosing it from the command menu would,
 * but leaves the user's draft alone, since the button sits above a composer that may hold a half-written message.
 * `compact` is `undefined` when the provider reports no compact command or the phone cannot send, so the notice keeps
 * its Usage button. A refusal shows a toast, as the command menu reports one.
 */
export const useAgentChatCompact = (
    chat: Pick<AgentChatController, 'runCommand' | 'snapshot'>,
    canSend: boolean,
): { compact: (() => Promise<void>) | undefined; isBusy: boolean } => {
    const { t } = useTranslation();
    const [isBusy, setBusy] = useState(false);
    const hasCompact = chat.snapshot?.commands?.some(({ name }) => name === 'compact') === true;
    const run = async (): Promise<void> => {
        setBusy(true);
        try {
            await chat.runCommand({ name: 'compact' });
        } catch {
            showToast('error', t('chat.commands.runFailed', { name: 'compact' }));
        } finally {
            setBusy(false);
        }
    };
    return {
        compact: canSend && hasCompact ? run : undefined,
        isBusy,
    };
};
