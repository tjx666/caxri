import { memo } from 'react';

import type { MobileTheme } from '../../theme/tokens';
import { ConversationEntry } from '../conversation/conversation-entry';
import { AgentChatAnsweredQuestions } from './agent-chat-answered-questions';
import { AgentChatDelegatedMessage } from './agent-chat-delegated-message';
import { AgentChatFeedback } from './agent-chat-feedback';
import { AgentChatPathChips } from './agent-chat-path-chips';
import { AgentChatPendingMessage } from './agent-chat-pending-message';
import { AgentChatReplyPlaceholder } from './agent-chat-reply-placeholder';
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
        onToggle,
        theme,
    }: {
        entry: Entry;
        /**
         * Folds or unfolds a turn (by turn id), a delegated task's pointer, or an answered question list (by entry id).
         */
        onToggle: (id: string) => void;
        theme: MobileTheme;
    }) => {
        switch (entry.kind) {
            case 'feedback': {
                return <AgentChatFeedback item={entry.notice} theme={theme} />;
            }
            case 'message': {
                return (
                    <ConversationEntry
                        entry={entry.message}
                        theme={theme}
                        userExtras={
                            entry.cited ? (
                                <AgentChatPathChips
                                    references={entry.cited.references}
                                    skills={entry.cited.skills}
                                    theme={theme}
                                />
                            ) : undefined
                        }
                    />
                );
            }
            case 'answered': {
                return (
                    <AgentChatAnsweredQuestions entry={entry} onToggle={onToggle} theme={theme} />
                );
            }
            case 'delegated': {
                return (
                    <AgentChatDelegatedMessage
                        id={entry.id}
                        isExpanded={entry.isExpanded}
                        onToggle={onToggle}
                        task={entry.task}
                        text={entry.text}
                        theme={theme}
                    />
                );
            }
            case 'work': {
                return (
                    <AgentChatWorkGroup
                        id={entry.id}
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
            case 'awaiting': {
                return <AgentChatReplyPlaceholder theme={theme} />;
            }
            case 'turn': {
                return <AgentChatTurnFold entry={entry} onToggle={onToggle} theme={theme} />;
            }
        }
    },
);
