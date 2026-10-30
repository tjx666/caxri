import { useEffect, useMemo, useState } from 'react';

import type { AgentChatWaitingEntry } from '@caxri/protocol';
import { useQueryClient } from '@tanstack/react-query';

import { useCaxriQuery } from '../../../queries/client';
import { useSessions } from '../../../stores/selectors';
import { useAgentChatPlanDismissals } from '../permissions/agent-chat-plan-dismissals';
import { useAgentChatPendingStore } from '../transcript/agent-chat-pending';
import { isAgentChatOnScreen, useAgentChatOnScreenStore } from './agent-chat-on-screen';
import { invalidateAgentChatWaiting, waitingTerminalKey } from './agent-chat-waiting-client';
import type { AgentChatWaitingArrivals, AgentChatWaitingView } from './agent-chat-waiting-queue';
import {
    agentChatWaitingQueue,
    agentChatWaitingRequestCount,
    nextAgentChatWaitingArrivals,
    nextAgentChatWaitingView,
} from './agent-chat-waiting-queue';

const NO_ENTRIES: readonly AgentChatWaitingEntry[] = [];
const NO_ARRIVALS: AgentChatWaitingArrivals = new Map();

export interface AgentChatWaiting {
    /**
     * The Chat or PTY Terminal the card asks about now, the oldest still waiting.
     */
    current: AgentChatWaitingEntry | undefined;
    /**
     * Requests left to ask across every waiting Chat and PTY Terminal, the current one included.
     */
    count: number;
    isCollapsed: boolean;
    setCollapsed: (isCollapsed: boolean) => void;
}

/**
 * What the waiting popup shows: every Chat with a running provider and every PTY Terminal Agent that waits on the user,
 * minus the ones on screen in this window and the requests already answered here. The list is read once and kept
 * current by `agentChat.patch` (see `isAgentChatWaitingPatch`) and by the Session snapshot's waiting Terminals (see
 * `waitingTerminalKey`), so it never polls.
 */
export function useAgentChatWaiting(): AgentChatWaiting {
    const { data } = useCaxriQuery('agentChat.pendingRequests', {}, { staleTime: Infinity });
    const chats = data?.entries ?? NO_ENTRIES;
    const answers = useAgentChatPendingStore((state) => state.answers);
    const dismissedPlans = useAgentChatPlanDismissals();
    const onScreen = useAgentChatOnScreenStore((state) => state.counts);
    const sessions = useSessions();
    const queryClient = useQueryClient();
    /**
     * A PTY Agent's waiting state reaches this window only as a Session update, not as an `agentChat.patch`, so the
     * Terminals the Sessions mark as waiting are what tells the list to be read again.
     */
    const waitingKey = waitingTerminalKey(sessions);
    useEffect(() => {
        invalidateAgentChatWaiting(queryClient);
    }, [queryClient, waitingKey]);
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
            dismissedPlans,
            isKnownSession: (sessionId) => sessionIds.has(sessionId),
            isOnScreen: (terminalId) => isAgentChatOnScreen(onScreen, terminalId),
        });
    }, [answers, arrivals, chats, dismissedPlans, onScreen, sessions]);
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
