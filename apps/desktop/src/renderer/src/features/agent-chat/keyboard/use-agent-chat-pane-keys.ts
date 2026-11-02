import type { KeyboardEvent, RefObject } from 'react';

import type { AgentChatComposerInput } from '../composer/agent-chat-composer-view';
import { useAgentChatPaneEscape } from '../hooks/use-agent-chat-pane-escape';
import { useAgentChatEdgeKeys } from './use-agent-chat-edge-keys';

/**
 * The Chat pane's bubble-phase keydown handler: Escape interrupts a running turn from anywhere in the pane while the
 * composer handles its own ({@link useAgentChatPaneEscape}), and Home/End and Cmd+ArrowUp/Down jump the transcript to
 * its top or bottom, as a page does in Chrome ({@link useAgentChatEdgeKeys}).
 */
export function useAgentChatPaneKeys(
    terminalId: string,
    snapshot: { activeTurnId?: string } | undefined,
    inputReference: RefObject<AgentChatComposerInput | null>,
    scroll: {
        jumpToLatest: () => void;
        scrollReference: RefObject<HTMLDivElement | null>;
        stopFollowing: () => void;
    },
): (event: KeyboardEvent<HTMLElement>) => void {
    const onEscapeKeyDown = useAgentChatPaneEscape({
        activeTurnId: snapshot?.activeTurnId,
        terminalId,
    });
    const onEdgeKeyDown = useAgentChatEdgeKeys({
        inputReference,
        jumpToLatest: scroll.jumpToLatest,
        scrollReference: scroll.scrollReference,
        stopFollowing: scroll.stopFollowing,
    });
    return (event) => {
        onEscapeKeyDown(event);
        onEdgeKeyDown(event);
    };
}
