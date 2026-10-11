import type { ReactNode, RefObject } from 'react';

import { AgentChatFindQueryContext } from './agent-chat-find';
import { AgentChatFindBar } from './agent-chat-find-bar';
import { useAgentChatFind } from './hooks/use-agent-chat-find';

/**
 * The conversation area with find in it: the bar over its top right, and the query its folded turns compare their text
 * with, so one that holds a match opens.
 */
export function AgentChatFindScope({
    children,
    contentReference,
    focusComposer,
    scrollReference,
    stopFollowing,
    terminalId,
}: {
    children: ReactNode;
    contentReference: RefObject<HTMLDivElement | null>;
    focusComposer: () => void;
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
            {children}
            {find.bar && <AgentChatFindBar {...find.bar} />}
        </AgentChatFindQueryContext>
    );
}
