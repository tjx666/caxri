import type { ReactNode, RefObject } from 'react';

import { AgentChatFindQueryContext } from './agent-chat-find';
import { AgentChatFindBar } from './agent-chat-find-bar';
import { useAgentChatFind } from './hooks/use-agent-chat-find';

/**
 * The conversation area with find in it: the bar in a strip above it, which the conversation gives up its height to
 * while find is open so no message hides under the bar, and the query its folded turns compare their text with, so one
 * that holds a match opens. The area below the bar is the positioning box for the conversation's overlays (the message
 * rail and Jump to latest).
 */
export function AgentChatFindScope({
    children,
    contentReference,
    focusComposer,
    hasUnsearchedHistory,
    scrollReference,
    stopFollowing,
    terminalId,
}: {
    children: ReactNode;
    contentReference: RefObject<HTMLDivElement | null>;
    focusComposer: () => void;
    /**
     * Older history exists beyond what the pane has loaded, so an empty search result covers only the loaded messages.
     */
    hasUnsearchedHistory: boolean;
    /**
     * The conversation's scroll view, which find scrolls to reveal a match after `stopFollowing` stops it following the
     * latest output.
     */
    scrollReference: RefObject<HTMLDivElement | null>;
    stopFollowing: () => void;
    terminalId: string;
}) {
    const find = useAgentChatFind({
        terminalId,
        scrollReference,
        contentReference,
        stopFollowing,
        focusComposer,
    });
    return (
        <AgentChatFindQueryContext value={find.searched}>
            <div className="flex h-full min-h-0 flex-col">
                {find.bar && <AgentChatFindBar {...find.bar} isPartial={hasUnsearchedHistory} />}
                <div className="relative min-h-0 flex-1">{children}</div>
            </div>
        </AgentChatFindQueryContext>
    );
}
