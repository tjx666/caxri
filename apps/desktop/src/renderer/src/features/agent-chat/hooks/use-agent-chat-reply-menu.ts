import type { MouseEvent, RefObject } from 'react';

import { useContextMenu } from '../../../hooks/use-context-menu';
import {
    agentChatSelectionInside,
    copyAgentChatMessageFromMenu,
    quoteAgentChatMessageFromMenu,
} from '../messages/agent-chat-message-menu-actions';
import { agentChatReplyMenu } from '../messages/agent-chat-user-message-menu';
import { useAgentChatTerminal } from './use-agent-chat-terminal';

/**
 * The `onContextMenu` handler of an Agent reply, which opens the menu built by {@link agentChatReplyMenu}: Copy (the
 * selection inside the reply), Copy Message (its Markdown source), and Add to Message. A link or card inside the reply
 * opens its own menu instead, since `useContextMenu` claims the event at the innermost handler.
 */
export function useAgentChatReplyMenu({
    container,
    text,
}: {
    container: RefObject<HTMLElement | null>;
    text: string;
}): (event: MouseEvent) => void {
    const terminalId = useAgentChatTerminal();
    return useContextMenu(() =>
        agentChatReplyMenu({
            text,
            selectedText: agentChatSelectionInside(container.current),
            onCopy: (value) => copyAgentChatMessageFromMenu(value, value !== text),
            onQuote:
                terminalId === undefined
                    ? undefined
                    : (value) => quoteAgentChatMessageFromMenu(terminalId, value),
        }),
    );
}
