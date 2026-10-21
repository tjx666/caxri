import { omit } from 'es-toolkit';

import { createStore } from '../../lib/store';

interface AgentChatOnScreenState {
    /**
     * Mounted Chat panes per Terminal whose Session is on screen in this window. A count rather than a flag, because a
     * pane remount (a split, a moved tab) mounts the new pane before the old one unmounts.
     */
    counts: Readonly<Record<string, number>>;
}

/**
 * Which Chats this window shows right now. The waiting popup leaves these out: a Chat on screen shows its own request
 * card above the composer, and the same question in two places could be answered twice.
 */
export const useAgentChatOnScreenStore = createStore<AgentChatOnScreenState>(
    'agent-chat-on-screen',
    () => ({ counts: {} }),
);

function adjust(terminalId: string, delta: number): void {
    const { counts } = useAgentChatOnScreenStore.getState();
    const next = (counts[terminalId] ?? 0) + delta;
    useAgentChatOnScreenStore.setState({
        counts: next > 0 ? { ...counts, [terminalId]: next } : omit(counts, [terminalId]),
    });
}

/**
 * Records that a Chat pane for `terminalId` is on screen and returns the call that takes it off again.
 */
export function markAgentChatOnScreen(terminalId: string): () => void {
    adjust(terminalId, 1);
    return () => adjust(terminalId, -1);
}

export function isAgentChatOnScreen(
    counts: AgentChatOnScreenState['counts'],
    terminalId: string,
): boolean {
    return (counts[terminalId] ?? 0) > 0;
}
