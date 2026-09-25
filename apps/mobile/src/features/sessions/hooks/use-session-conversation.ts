import { useConversationTimeline } from '../../conversation/use-conversation-timeline';
import type { MobileSessionItem } from '../session-model';
import type { SessionSegment } from '../session-ui-state';
import { resolveSessionConversationSegment } from '../session-ui-state';

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
    const timeline = useConversationTimeline({
        enabled:
            isDetailVisible &&
            (remembered === undefined || remembered === 'conversation' || Boolean(keepVisible)),
        sessionId: selected?.id ?? null,
    });
    const selection = resolveSessionConversationSegment({
        hasAgentEndpoint: selected?.primaryAgentEndpoint !== undefined,
        remembered,
        status: timeline.status,
    });
    return {
        timeline,
        fallback: selection.fallback,
        segment: selected ? selection.segment : 'terminal',
    };
};
