import type { KeyboardEvent } from 'react';
import { useRef, useState } from 'react';

import { mentionAtCaret } from '../../../lib/suggestion-options';
import {
    agentChatSelectionCaret,
    isAgentChatCaretKey,
    isAgentChatCaretKeyRelease,
} from '../agent-chat-suggestions';

/**
 * The composer caret the user placed and the `@word` at it, for the `@` Sessions list that follows that word. There is
 * no caret until the user edits the draft or moves the caret, so a restored draft that ends in `@word` does not open
 * the list on its own, and hiding the Chat (`isShown` turning false) forgets it again.
 */
export function useAgentChatPlacedCaret(draft: string, isShown: boolean) {
    const [caret, setCaret] = useState<number>();
    // Reset during render: coming back to a draft that ends in `@word` waits for the user again, as a restored draft does.
    const [wasShown, setWasShown] = useState(isShown);
    if (wasShown !== isShown) {
        setWasShown(isShown);
        if (!isShown) setCaret(undefined);
    }
    const pressedCaretKey = useRef<string>(undefined);
    return {
        mention: caret === undefined ? undefined : mentionAtCaret(draft, caret),
        /**
         * Places the caret without an input event, as after inserting text programmatically.
         */
        setCaret,
        /**
         * Call from the input's change and click events: the user edited the draft or placed the caret, so the list
         * follows it.
         */
        trackCaret: (element: HTMLTextAreaElement) => setCaret(element.selectionStart),
        /**
         * Call first from the input's key-down event, before any handler that may consume the key: it remembers an
         * unmodified caret key, so only that key's own release moves the list (see `trackCaretKey`).
         */
        notePressedKey: (event: KeyboardEvent<HTMLTextAreaElement>) => {
            pressedCaretKey.current = isAgentChatCaretKey(event) ? event.key : undefined;
        },
        /**
         * Call from the input's key-up event: a caret key the user pressed here moves the list with the caret.
         */
        trackCaretKey: (event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (!isAgentChatCaretKeyRelease(pressedCaretKey.current, event)) return;
            pressedCaretKey.current = undefined;
            setCaret(event.currentTarget.selectionStart);
        },
        /**
         * Call from the input's select event. It follows the caret only once the user has touched the draft, since
         * focus moving into the composer reports a selection too.
         */
        followSelection: (element: HTMLTextAreaElement) =>
            setCaret((current) => agentChatSelectionCaret(current, element.selectionStart)),
    };
}
