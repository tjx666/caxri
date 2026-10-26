import type { RefObject } from 'react';
import { useEffect } from 'react';

import { useLatestReference } from '@/hooks/use-latest-reference';

import type { AgentChatApprovalDecision } from './agent-chat-approval-commands';
import { registerAgentChatApproval } from './agent-chat-approval-commands';

/**
 * Lets the `agentChat.allowRequest` and `agentChat.denyRequest` keybindings answer this approval card while it is the
 * one focus is nearest to (see `agentChatApprovalKeyOwner`). The global shortcut dispatcher runs in the capture phase,
 * so an answered key never reaches the composer as a steer.
 */
export function useAgentChatApprovalKeys(
    cardReference: RefObject<HTMLElement | null>,
    {
        armDelayMs,
        isEnabled,
        onDecision,
    }: {
        /**
         * Keys do nothing for this long after the card appears, like the pointer guard on its buttons.
         */
        armDelayMs: number;
        isEnabled: boolean;
        onDecision: (decision: AgentChatApprovalDecision) => void;
    },
): void {
    const latestDecision = useLatestReference(onDecision);
    useEffect(() => {
        const card = cardReference.current;
        if (!isEnabled || !card) return;
        return registerAgentChatApproval(card, {
            answer: (decision) => latestDecision.current(decision),
            armedAt: performance.now() + armDelayMs,
        });
    }, [armDelayMs, cardReference, isEnabled, latestDecision]);
}
