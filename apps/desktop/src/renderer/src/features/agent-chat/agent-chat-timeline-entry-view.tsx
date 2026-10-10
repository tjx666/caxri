import type { ReactNode } from 'react';
import { memo } from 'react';

import { AgentChatNotice, AgentChatReply, AgentChatUserMessage } from './agent-chat-message';
import type { AgentChatTimelineEntry } from './agent-chat-timeline';
import { AgentChatTurnFold } from './agent-chat-turn-fold';
import { AgentChatWorkGroup } from './agent-chat-work-group';

type MessageItem = Extract<AgentChatTimelineEntry, { kind: 'item' }>['item'];

/**
 * A streamed delta replaces only the item it appends to (`applyAgentChatPatch` keeps every other item's identity), so
 * the rest of the transcript skips rendering entirely.
 */
const AgentChatMessageItem = memo(
    ({ item, onOpenFile }: { item: MessageItem; onOpenFile?: (target: string) => void }) => {
        switch (item.type) {
            case 'userMessage': {
                return <AgentChatUserMessage images={item.images} text={item.text} />;
            }
            case 'agentMessage': {
                return <AgentChatReply item={item} onOpenFile={onOpenFile} />;
            }
            case 'notice': {
                return <AgentChatNotice item={item} />;
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
            return <AgentChatMessageItem item={entry.item} onOpenFile={onOpenFile} />;
        }
        case 'work': {
            return <AgentChatWorkGroup items={entry.items} onOpenFile={onOpenFile} />;
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
