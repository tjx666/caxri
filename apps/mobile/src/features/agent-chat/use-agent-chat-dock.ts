import { useState } from 'react';

import { useTranslation } from '../../i18n';
import { agentChatDockSummary, isAgentChatDockFolded } from './agent-chat-dock-summary';
import type { AgentChatController } from './use-agent-chat';
import { useIsKeyboardShown } from './use-keyboard-shown';

/**
 * Whether the goal bar, status row, and queue card fold into one summary row (`agentChatDockSummary`), and the user's
 * toggle for it. The toggle resets each time the keyboard goes down, so the next time the user types the dock starts
 * folded again.
 */
export const useAgentChatDock = (chat: AgentChatController, provider: string) => {
    const { t } = useTranslation();
    const { snapshot } = chat;
    const isKeyboardShown = useIsKeyboardShown();
    const [isExpanded, setExpanded] = useState(false);
    // Reset during render: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
    if (!isKeyboardShown && isExpanded) setExpanded(false);
    const summary = agentChatDockSummary(
        snapshot,
        {
            isSavedCopy: chat.savedAt !== undefined,
            provider,
            queueCount:
                Math.max(snapshot?.queueLength ?? 0, snapshot?.queue?.length ?? 0) +
                chat.pending.queue.length,
        },
        t,
    );
    return {
        isExpanded,
        isFolded: isAgentChatDockFolded({
            isExpanded,
            isKeyboardShown,
            isStacked: summary.isStacked,
        }),
        isSummaryShown: isKeyboardShown && summary.isStacked,
        segments: summary.segments,
        toggle: (): void => setExpanded((current) => !current),
    };
};
