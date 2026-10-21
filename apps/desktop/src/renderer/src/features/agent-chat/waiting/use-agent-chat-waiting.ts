import { useMemo, useState } from 'react';

import type { AgentChatWaitingChat } from '@caxri/protocol';

import { useCaxriQuery } from '../../../queries/client';
import { useSessions } from '../../../stores/selectors';
import { useAgentChatPendingStore } from '../transcript/agent-chat-pending';
import { isAgentChatOnScreen, useAgentChatOnScreenStore } from './agent-chat-on-screen';
import type { AgentChatWaitingArrivals, AgentChatWaitingView } from './agent-chat-waiting-queue';
import {
    agentChatWaitingQueue,
    agentChatWaitingRequestCount,
    nextAgentChatWaitingArrivals,
    nextAgentChatWaitingView,
} from './agent-chat-waiting-queue';

const NO_CHATS: readonly AgentChatWaitingChat[] = [];
const NO_ARRIVALS: AgentChatWaitingArrivals = new Map();

export interface AgentChatWaiting {
    /**
     * The Chat the card asks about now, the oldest still waiting.
     */
    current: AgentChatWaitingChat | undefined;
    /**
     * Requests left to ask across every waiting Chat, the current one included.
     */
    count: number;
    isCollapsed: boolean;
    setCollapsed: (isCollapsed: boolean) => void;
}

/**
 * What the waiting popup shows: every Chat with a running provider that waits on the user, minus the ones on screen in
 * this window and the requests already answered here. The list is read once and kept current by `agentChat.patch` (see
 * `isAgentChatWaitingPatch`), so it never polls.
 */
export function useAgentChatWaiting(): AgentChatWaiting {
    const { data } = useCaxriQuery('agentChat.pendingRequests', {}, { staleTime: Infinity });
    const chats = data?.chats ?? NO_CHATS;
    const answers = useAgentChatPendingStore((state) => state.answers);
    const onScreen = useAgentChatOnScreenStore((state) => state.counts);
    const sessions = useSessions();
    /**
     * Arrival order and the fold are derived from each read during render and stored only when they change (React's
     * "adjusting state when a prop changes" pattern), so a new request unfolds the card in the frame it arrives.
     */
    const [storedArrivals, setArrivals] = useState(NO_ARRIVALS);
    const arrivals = nextAgentChatWaitingArrivals(storedArrivals, chats);
    if (arrivals !== storedArrivals) setArrivals(arrivals);
    const queue = useMemo(() => {
        const sessionIds = new Set(sessions?.map((session) => session.id));
        return agentChatWaitingQueue(chats, {
            answers,
            arrivals,
            isKnownSession: (sessionId) => sessionIds.has(sessionId),
            isOnScreen: (terminalId) => isAgentChatOnScreen(onScreen, terminalId),
        });
    }, [answers, arrivals, chats, onScreen, sessions]);
    const count = agentChatWaitingRequestCount(queue);
    const [storedView, setView] = useState<AgentChatWaitingView>({ isCollapsed: false, count: 0 });
    const view = nextAgentChatWaitingView(storedView, count);
    if (view !== storedView) setView(view);
    return {
        current: queue[0],
        count,
        isCollapsed: view.isCollapsed,
        setCollapsed: (isCollapsed) => setView({ isCollapsed, count }),
    };
}
