import { memo } from 'react';

import type { MobileTheme } from '../../theme/tokens';
import { ConversationEntry } from '../conversation/conversation-entry';
import { AgentChatPendingMessage } from './agent-chat-pending-message';
import type { AgentChatTimelineEntry as Entry } from './agent-chat-timeline';
import { AgentChatTurnArtifacts } from './agent-chat-turn-artifacts';
import { AgentChatTurnFold } from './agent-chat-turn-fold';
import { AgentChatWorkGroup } from './agent-chat-work-group';

/**
 * One row of the phone's Chat timeline. Messages draw through the shared Conversation renderer, so a Chat's replies,
 * bubbles, and notices look like a terminal Agent's; work, a turn's artifacts, and its `Worked for` fold row are the
 * Chat's own, and so is a message still on its way. Memoized so a streamed patch redraws only the rows whose entry
 * changed (`stabilizeAgentChatEntries` keeps the others the same objects).
 */
export const AgentChatTimelineEntry = memo(
    ({
        entry,
        onToggleTurn,
        theme,
    }: {
        entry: Entry;
        onToggleTurn: (turnId: string) => void;
        theme: MobileTheme;
    }) => {
        switch (entry.kind) {
            case 'message': {
                return <ConversationEntry entry={entry.message} theme={theme} />;
            }
            case 'work': {
                return (
                    <AgentChatWorkGroup
                        rows={entry.rows}
                        summarized={entry.summarized}
                        theme={theme}
                    />
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
                return <AgentChatTurnFold entry={entry} onToggle={onToggleTurn} theme={theme} />;
            }
        }
    },
);
