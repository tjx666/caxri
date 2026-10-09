import { isAgentChatTerminal } from '../../agent-chat/agent-chat-model';
import { useConversationTimeline } from '../../conversation/use-conversation-timeline';
import type { MobileSessionItem } from '../session-model';
import type { SessionSegment } from '../session-ui-state';
import { hasKnownConversationAgent, resolveSessionConversationSegment } from '../session-ui-state';

export const useSessionConversation = ({
    isDetailVisible,
    keepVisible,
    remembered,
    selected,
}: {
    isDetailVisible: boolean;
    keepVisible?: boolean;
    remembered: SessionSegment | undefined;
    selected: MobileSessionItem | null;
}) => {
    const isChat = isAgentChatTerminal(selected?.primaryTerminal);
    const timeline = useConversationTimeline({
        // A Chat has no PTY transcript; its view reads the Chat projection instead.
        enabled:
            isDetailVisible &&
            !isChat &&
            (remembered === undefined || remembered === 'conversation' || Boolean(keepVisible)),
        sessionId: selected?.id ?? null,
    });
    const selection = resolveSessionConversationSegment({
        hasAgentEndpoint: selected?.primaryAgentEndpoint !== undefined,
        hasKnownAgent: hasKnownConversationAgent(selected?.primaryTerminal),
        isChat,
        remembered,
        status: timeline.status,
    });
    return {
        timeline,
        fallback: selection.fallback,
        hasConversation: selected ? selection.hasConversation : false,
        segment: selected ? selection.segment : 'terminal',
    };
};
