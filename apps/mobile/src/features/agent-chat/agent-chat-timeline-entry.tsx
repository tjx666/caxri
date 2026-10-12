import type { MobileTheme } from '../../theme/tokens';
import { ConversationEntry, ConversationTurnDivider } from '../conversation/conversation-entry';
import { AgentChatPendingMessage } from './agent-chat-pending-message';
import type { AgentChatTimelineEntry as Entry } from './agent-chat-timeline';
import { agentChatTurnTone } from './agent-chat-timeline';
import { AgentChatTurnArtifacts } from './agent-chat-turn-artifacts';
import { AgentChatWorkGroup } from './agent-chat-work-group';

/**
 * One row of the phone's Chat timeline. Messages draw through the shared Conversation renderer, so a Chat's replies,
 * bubbles, and notices look like a terminal Agent's; work, a turn's artifacts, and its `Worked for` footer are the
 * Chat's own, and so is a message still on its way.
 */
export const AgentChatTimelineEntry = ({ entry, theme }: { entry: Entry; theme: MobileTheme }) => {
    switch (entry.kind) {
        case 'message': {
            return <ConversationEntry entry={entry.message} theme={theme} />;
        }
        case 'work': {
            return (
                <AgentChatWorkGroup rows={entry.rows} summarized={entry.summarized} theme={theme} />
            );
        }
        case 'artifacts': {
            return <AgentChatTurnArtifacts artifacts={entry.artifacts} theme={theme} />;
        }
        case 'pending': {
            return (
                <AgentChatPendingMessage
                    id={entry.id}
                    imageUris={entry.imageUris}
                    text={entry.text}
                    theme={theme}
                />
            );
        }
        case 'turn': {
            return (
                <ConversationTurnDivider
                    label={entry.label}
                    testID={`agent-chat-${entry.id.replace(':', '-')}`}
                    theme={theme}
                    tone={agentChatTurnTone(entry.status)}
                />
            );
        }
    }
};
