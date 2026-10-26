import { useEffect, useRef } from 'react';

import type { AgentChatWaitingChat } from '@caxri/protocol';

import { useLatestReference } from '@/hooks/use-latest-reference';

import {
    agentChatWaitingFocusTarget,
    agentChatWaitingReturnFocus,
    registerAgentChatWaitingFocus,
    registerAgentChatWaitingUnfold,
    useAgentChatWaitingFoldStore,
} from './agent-chat-waiting-focus';

/**
 * The popup's keyboard and fold wiring. `Focus Waiting Request` moves focus in (unfolding the card first) and remembers
 * where it came from; answering from inside the card keeps focus on the next request instead of dropping it on the
 * document body; and once the last request is answered, focus goes back to where the user was. The fold is published
 * for the status bar, which shows the folded popup and unfolds it.
 */
export function useAgentChatWaitingFocus({
    count,
    current,
    isCollapsed,
    setCollapsed,
}: {
    count: number;
    current: AgentChatWaitingChat | undefined;
    isCollapsed: boolean;
    setCollapsed: (isCollapsed: boolean) => void;
}) {
    const containerReference = useRef<HTMLDivElement | null>(null);
    const cardReference = useRef<HTMLElement | null>(null);
    /**
     * Set when the card should take focus as soon as it shows the next request: the focus command ran while the popup
     * was folded, or the user answered from inside the card.
     */
    const shouldFocusCard = useRef(false);
    const returnFocusTo = useRef<HTMLElement | null>(null);
    const latestCollapse = useLatestReference(setCollapsed);
    const hasRequest = current !== undefined;
    const requestKey = current && `${current.terminalId}:${current.requests[0]?.id}`;

    useEffect(() => {
        if (!hasRequest) return;
        const unregisterFocus = registerAgentChatWaitingFocus(() => {
            const active = document.activeElement;
            if (
                active instanceof HTMLElement &&
                active !== document.body &&
                !containerReference.current?.contains(active)
            )
                returnFocusTo.current = active;
            if (cardReference.current) {
                agentChatWaitingFocusTarget(cardReference.current).focus();
                return;
            }
            shouldFocusCard.current = true;
            latestCollapse.current(false);
        });
        const unregisterUnfold = registerAgentChatWaitingUnfold(() =>
            latestCollapse.current(false),
        );
        return () => {
            unregisterFocus();
            unregisterUnfold();
        };
    }, [hasRequest, latestCollapse]);

    useEffect(() => {
        useAgentChatWaitingFoldStore.setState({
            foldedCount: hasRequest && isCollapsed ? count : 0,
        });
    }, [count, hasRequest, isCollapsed]);
    useEffect(() => () => useAgentChatWaitingFoldStore.setState({ foldedCount: 0 }), []);

    useEffect(() => {
        if (requestKey === undefined) {
            shouldFocusCard.current = false;
            const active = document.activeElement;
            const target = agentChatWaitingReturnFocus(
                returnFocusTo.current,
                !active ||
                    active === document.body ||
                    containerReference.current?.contains(active) === true,
            );
            returnFocusTo.current = null;
            target?.focus();
            return;
        }
        if (!shouldFocusCard.current || !cardReference.current) return;
        shouldFocusCard.current = false;
        agentChatWaitingFocusTarget(cardReference.current).focus();
    }, [requestKey]);

    return {
        containerReference,
        /**
         * The card's ref: a card mounting after the focus command unfolded it takes focus here.
         */
        attachCard: (element: HTMLElement | null): void => {
            cardReference.current = element;
            if (!element || !shouldFocusCard.current) return;
            shouldFocusCard.current = false;
            agentChatWaitingFocusTarget(element).focus();
        },
        /**
         * Runs as an answer takes the request away. Only an answer given from inside the popup keeps focus on the next
         * card; one given by a window-level key from the document body leaves focus where it was, since the popup never
         * takes focus by itself.
         */
        onAnswered: (): void => {
            if (containerReference.current?.contains(document.activeElement))
                shouldFocusCard.current = true;
        },
    };
}
