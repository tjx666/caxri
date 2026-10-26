import type { RefObject } from 'react';
import { useEffect } from 'react';

import { useLatestReference } from '@/hooks/use-latest-reference';

import { isImeComposing } from '../../../../lib/ime';
import { AGENT_CHAT_PANE_ATTRIBUTE } from '../../permissions/agent-chat-approval-commands';
import type { AgentChatKeyTarget } from '../../permissions/agent-chat-approval-keys';
import {
    isAgentChatComposerEmpty,
    isAgentChatStaticTarget,
} from '../../permissions/agent-chat-approval-keys';

/**
 * The attribute every question card carries; only the first one in a pane answers to Enter from outside it.
 */
export const AGENT_CHAT_QUESTION_ATTRIBUTE = 'data-agent-chat-question';

/**
 * Whether the focused element does nothing with Enter, so a question card may take it: nothing focused, an empty Chat
 * composer (a contenteditable editor exposing its draft as `value`, `agent-chat-composer-editor.tsx`), or a static
 * element such as the transcript. A text field, a Terminal or Editor (both type into a hidden `textarea`), a composer
 * holding a draft, and a button, link, tree row, or other control keep their own Enter. An empty composer's Enter would
 * otherwise send the first queued message, which the turn waiting on the question could not take anyway.
 */
export function isAgentChatQuestionEnterTarget(target: AgentChatKeyTarget | null): boolean {
    // The composer's editor is a `textbox` too, so it is read by its draft before the static-target rule.
    if (target?.isContentEditable === true) return isAgentChatComposerEmpty(target);
    return isAgentChatStaticTarget(target);
}

/**
 * Whether a key press answers the question card from outside it: plain Enter on a target that does nothing with it
 * (`isAgentChatQuestionEnterTarget`). A held key never answers twice, an IME composition owns its keys, and a modifier
 * leaves the chord to whoever owns it.
 */
export function isAgentChatQuestionEnterKey(event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    isComposing: boolean;
    repeat: boolean;
}): boolean {
    if (event.key !== 'Enter' || event.isComposing || event.repeat) return false;
    return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

/**
 * Lets Enter answer the question card while focus sits outside it, usually in the empty composer the card appeared
 * above: the Submit button promises Enter, but focus stays where it was when the card shows up. A docked card takes
 * Enter only from its own Chat pane and only as the first question in it. A window-wide card (the waiting popup, which
 * never takes focus by itself) takes it with nothing focused or from a Chat pane without its own question; the sidebar,
 * Files, and every other surface keep their Enter, as does a Chat pane whose own question answers it. It listens in the
 * capture phase, so the key never reaches the composer.
 */
export function useAgentChatQuestionEnterKey(
    cardReference: RefObject<HTMLElement | null>,
    {
        armedAt,
        isEnabled,
        isWindowWide,
        onEnter,
    }: {
        /**
         * The `performance.now()` time before which Enter is ignored, so a key meant for something else cannot answer a
         * card that just appeared.
         */
        armedAt: number;
        isEnabled: boolean;
        isWindowWide: boolean;
        onEnter: () => void;
    },
): void {
    const latestEnter = useLatestReference(onEnter);
    useEffect(() => {
        const card = cardReference.current;
        const paneSelector = `[${CSS.escape(AGENT_CHAT_PANE_ATTRIBUTE)}]`;
        const questionSelector = `[${CSS.escape(AGENT_CHAT_QUESTION_ATTRIBUTE)}]`;
        const pane = card?.closest(paneSelector);
        if (!isEnabled || !card || !pane) return;
        const scope: Document | Element = isWindowWide ? document : pane;
        const isAnswerFrom = (target: HTMLElement | null): boolean => {
            if (target && card.contains(target)) return false;
            if (!isWindowWide) return pane.querySelector(questionSelector) === card;
            if (!target) return true;
            const targetPane = target.closest(paneSelector);
            return targetPane !== null && !targetPane.querySelector(questionSelector);
        };
        const onKeyDown = (event: Event): void => {
            // An event's timeStamp shares performance.now()'s clock.
            if (!(event instanceof KeyboardEvent) || event.timeStamp < armedAt) return;
            const focused = event.target instanceof HTMLElement ? event.target : null;
            // Nothing focused reports the body, which is no text field.
            const target = focused === document.body ? null : focused;
            const isAnswerKey =
                isAgentChatQuestionEnterKey({
                    key: event.key,
                    altKey: event.altKey,
                    ctrlKey: event.ctrlKey,
                    isComposing: isImeComposing(event),
                    metaKey: event.metaKey,
                    repeat: event.repeat,
                    shiftKey: event.shiftKey,
                }) &&
                isAgentChatQuestionEnterTarget(
                    target && {
                        isContentEditable: target.isContentEditable,
                        role: target.getAttribute('role'),
                        tagName: target.tagName,
                        value: (target as { value?: unknown }).value,
                    },
                ) &&
                isAnswerFrom(target);
            if (!isAnswerKey) return;
            event.preventDefault();
            event.stopPropagation();
            latestEnter.current();
        };
        scope.addEventListener('keydown', onKeyDown, { capture: true });
        return () => scope.removeEventListener('keydown', onKeyDown, true);
    }, [armedAt, cardReference, isEnabled, isWindowWide, latestEnter]);
}
