import type { ReactNode } from 'react';
import { memo } from 'react';

import type { AgentChatTurnArtifacts, AgentChatTurnMetrics } from '@caxri/protocol';

import { AgentChatNotice, AgentChatReply } from '../messages/agent-chat-message';
import { AgentChatUserMessage } from '../messages/agent-chat-user-message';
import { AgentChatWorkGroup } from '../tools/agent-chat-work-group';
import { AgentChatTurnArtifactList } from '../turns/agent-chat-turn-artifact-list';
import { AgentChatTurnFold } from '../turns/agent-chat-turn-fold';
import type { AgentChatTimelineEntry } from './agent-chat-timeline';
import { AgentChatAnsweredQuestions } from './questions/agent-chat-answered-questions';

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
        metrics,
        onOpenFile,
    }: {
        artifacts?: AgentChatTurnArtifacts;
        isFinalReply?: boolean;
        item: MessageItem;
        metrics?: AgentChatTurnMetrics;
        onOpenFile?: (target: string) => void;
    }) => {
        switch (item.type) {
            case 'userMessage': {
                return (
                    <AgentChatUserMessage
                        createdAt={item.createdAt}
                        delegatedTask={item.delegatedTask}
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
                        metrics={metrics}
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
 * behind its duration. `buildAgentChatTimeline` hands back the same entry object while its source items keep their
 * identities, so a settled entry skips rendering while a later turn streams.
 */
const MemoizedTimelineEntry = memo(
    ({
        entry,
        onOpenFile,
    }: {
        entry: AgentChatTimelineEntry;
        /**
         * Opens a file the reply cites, resolved against the Chat Terminal's reachable Projects.
         */
        onOpenFile?: (target: string) => void;
    }): ReactNode => {
        switch (entry.kind) {
            case 'item': {
                return (
                    <AgentChatMessageItem
                        artifacts={entry.artifacts}
                        isFinalReply={entry.isFinalReply}
                        item={entry.item}
                        metrics={entry.metrics}
                        onOpenFile={onOpenFile}
                    />
                );
            }
            case 'work': {
                return (
                    <AgentChatWorkGroup
                        isOpen={entry.isOpen}
                        isSteerReply={entry.isSteerReply}
                        items={entry.items}
                        onOpenFile={onOpenFile}
                    />
                );
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
    },
);

export function AgentChatTimelineEntryView(properties: {
    entry: AgentChatTimelineEntry;
    onOpenFile?: (target: string) => void;
}): ReactNode {
    return <MemoizedTimelineEntry {...properties} />;
}
