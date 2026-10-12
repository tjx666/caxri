import type { ReactNode } from 'react';
import { memo } from 'react';

import type { AgentChatTurnArtifacts } from '@caxri/protocol';

import { AgentChatAnsweredQuestions } from './agent-chat-answered-questions';
import { AgentChatNotice, AgentChatReply } from './agent-chat-message';
import type { AgentChatTimelineEntry } from './agent-chat-timeline';
import { AgentChatTurnArtifactList } from './agent-chat-turn-artifact-list';
import { AgentChatTurnFold } from './agent-chat-turn-fold';
import { AgentChatUserMessage } from './agent-chat-user-message';
import { AgentChatWorkGroup } from './agent-chat-work-group';

type MessageItem = Extract<AgentChatTimelineEntry, { kind: 'item' }>['item'];

/**
 * A streamed delta replaces only the item it appends to (`applyAgentChatPatch` keeps every other item's identity), so
 * the rest of the transcript skips rendering entirely.
 */
const AgentChatMessageItem = memo(
    ({
        artifacts,
        isFinalReply,
        item,
        onOpenFile,
    }: {
        artifacts?: AgentChatTurnArtifacts;
        isFinalReply?: boolean;
        item: MessageItem;
        onOpenFile?: (target: string) => void;
    }) => {
        switch (item.type) {
            case 'userMessage': {
                return (
                    <AgentChatUserMessage
                        createdAt={item.createdAt}
                        delivery={item.delivery}
                        id={item.id}
                        images={item.images}
                        text={item.text}
                        onOpenFile={onOpenFile}
                    />
                );
            }
            case 'agentMessage': {
                return (
                    <AgentChatReply
                        artifacts={artifacts}
                        canCopy={isFinalReply === true}
                        item={item}
                        onOpenFile={onOpenFile}
                    />
                );
            }
            case 'notice': {
                return item.kind === 'answered' ? (
                    <AgentChatAnsweredQuestions item={item} />
                ) : (
                    <AgentChatNotice item={item} />
                );
            }
        }
    },
);

/**
 * One timeline entry: a message or notice inline, a run of work as one collapsible group, or a finished turn folded
 * behind its duration.
 */
export function AgentChatTimelineEntryView({
    entry,
    onOpenFile,
}: {
    entry: AgentChatTimelineEntry;
    /**
     * Opens a file the reply cites, resolved against the Chat Terminal's reachable Projects.
     */
    onOpenFile?: (target: string) => void;
}): ReactNode {
    switch (entry.kind) {
        case 'item': {
            return (
                <AgentChatMessageItem
                    artifacts={entry.artifacts}
                    isFinalReply={entry.isFinalReply}
                    item={entry.item}
                    onOpenFile={onOpenFile}
                />
            );
        }
        case 'work': {
            return <AgentChatWorkGroup items={entry.items} onOpenFile={onOpenFile} />;
        }
        case 'artifacts': {
            return <AgentChatTurnArtifactList artifacts={entry.artifacts} />;
        }
        case 'turn': {
            return (
                <AgentChatTurnFold
                    entry={entry}
                    renderEntry={(child) => (
                        <AgentChatTimelineEntryView
                            entry={child}
                            key={child.kind === 'item' ? child.item.id : child.id}
                            onOpenFile={onOpenFile}
                        />
                    )}
                />
            );
        }
    }
}
