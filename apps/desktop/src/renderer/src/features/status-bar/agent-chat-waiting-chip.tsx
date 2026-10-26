import { CircleHelp } from 'lucide-react';

import { useTranslation } from '../../i18n';
import {
    unfoldAgentChatWaiting,
    useAgentChatWaitingFoldStore,
} from '../agent-chat/waiting/agent-chat-waiting-focus';
import { StatusItem } from './status-item';

/**
 * The folded waiting popup: how many Chat questions and approvals still wait on the user. A click unfolds the card at
 * the top of the window. It keeps the clickable item's default foreground, like the peer-approval chip: a request
 * waiting on the user is not a degradation.
 */
export function AgentChatWaitingChip() {
    const { t } = useTranslation();
    const count = useAgentChatWaitingFoldStore((state) => state.foldedCount);
    if (count === 0) return null;
    const label = t('agentChat.waiting.expand', { count });
    return (
        <StatusItem
            icon={<CircleHelp />}
            ariaLabel={label}
            title={label}
            className="statusbar-agent-chat-waiting"
            onClick={unfoldAgentChatWaiting}
        >
            {t('agentChat.waiting.pending', { count })}
        </StatusItem>
    );
}
