import type { AgentChatWaitingChat } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import { useTranslation } from '../../../i18n';
import { useSessionById, useTerminal } from '../../../stores/selectors';
import { sessionTitleForDisplay } from '../../session/session-title';
import { agentChatWaitingAnnouncementKey } from './agent-chat-waiting-announcement';

/**
 * The popup's screen-reader live region: names the provider and Session of the request that just arrived. The region
 * stays mounted (an empty one announces nothing) so a change in text is what is read.
 */
export function AgentChatWaitingStatus({ chat }: { chat: AgentChatWaitingChat | undefined }) {
    const { t } = useTranslation();
    const session = useSessionById(chat?.sessionId);
    const terminal = useTerminal(chat?.terminalId ?? '');
    const provider = terminal?.provider ? agentProviderCatalog[terminal.provider] : undefined;
    const request = chat?.requests[0];
    const text =
        chat && request
            ? t(agentChatWaitingAnnouncementKey(request.kind), {
                  provider: provider?.displayName ?? t('agentChat.waiting.agent'),
                  session: session ? sessionTitleForDisplay(session.title, t) : '',
              })
            : '';
    return (
        <span className="sr-only" role="status">
            {text}
        </span>
    );
}
