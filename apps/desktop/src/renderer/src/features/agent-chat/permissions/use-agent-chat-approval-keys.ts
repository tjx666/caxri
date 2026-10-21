import type { RefObject } from 'react';
import { useEffect } from 'react';

import { useLatestReference } from '@/hooks/use-latest-reference';

import { isImeComposing } from '../../../lib/ime';
import { agentChatApprovalKeyDecision, isAgentChatComposerEmpty } from './agent-chat-approval-keys';

/**
 * The attribute the Chat pane carries, so an approval card can listen for its keys anywhere in its own pane.
 */
export const AGENT_CHAT_PANE_ATTRIBUTE = 'data-agent-chat-pane';

/**
 * The attribute every approval card carries; only the first one in a pane answers to the keys.
 */
export const AGENT_CHAT_APPROVAL_ATTRIBUTE = 'data-agent-chat-approval';

/**
 * Answers the first approval card in this card's Chat pane from the keyboard (see `agentChatApprovalKeyDecision`). It
 * listens in the capture phase on the pane, so an answered key never reaches the composer as a steer.
 */
export function useAgentChatApprovalKeys(
    cardReference: RefObject<HTMLElement | null>,
    {
        isEnabled,
        onDecision,
    }: { isEnabled: boolean; onDecision: (decision: 'accept' | 'decline') => void },
): void {
    const latestDecision = useLatestReference(onDecision);
    useEffect(() => {
        const card = cardReference.current;
        const pane = card?.closest(`[${CSS.escape(AGENT_CHAT_PANE_ATTRIBUTE)}]`);
        if (!isEnabled || !card || !pane) return;
        const onKeyDown = (event: Event): void => {
            if (!(event instanceof KeyboardEvent)) return;
            if (pane.querySelector(`[${CSS.escape(AGENT_CHAT_APPROVAL_ATTRIBUTE)}]`) !== card)
                return;
            const target = event.target instanceof HTMLElement ? event.target : null;
            const decision = agentChatApprovalKeyDecision(
                {
                    key: event.key,
                    altKey: event.altKey,
                    ctrlKey: event.ctrlKey,
                    isComposing: isImeComposing(event),
                    metaKey: event.metaKey,
                    repeat: event.repeat,
                    shiftKey: event.shiftKey,
                },
                { isComposerEmpty: isAgentChatComposerEmpty(target) },
            );
            if (!decision) return;
            event.preventDefault();
            event.stopPropagation();
            latestDecision.current(decision);
        };
        pane.addEventListener('keydown', onKeyDown, { capture: true });
        return () => pane.removeEventListener('keydown', onKeyDown, true);
    }, [cardReference, isEnabled, latestDecision]);
}
