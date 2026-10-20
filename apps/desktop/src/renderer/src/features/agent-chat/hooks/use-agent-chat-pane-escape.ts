import type { KeyboardEvent } from 'react';

import { isImeComposing } from '../../../lib/ime';
import { shouldAgentChatPaneEscapeStop } from '../transcript/agent-chat-presentation';
import { useAgentChatStop } from './use-agent-chat-stop';

/**
 * Anything that opens above the Chat and owns Escape until it closes: menus, listboxes, and dialogs. Checked on the
 * whole document because popups render in a portal outside the pane.
 */
const OVERLAY_SELECTOR = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]';

function isEditable(target: EventTarget): boolean {
    return (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input, textarea, select') !== null)
    );
}

/**
 * The Chat pane's bubble-phase keydown handler: Escape interrupts a running turn wherever focus sits in the pane (the
 * transcript, a button), not only in the composer. It stands down for the composer and other editable fields, for an
 * open overlay, and for a key an inner handler already consumed (`shouldAgentChatPaneEscapeStop`).
 */
export function useAgentChatPaneEscape({
    activeTurnId,
    terminalId,
}: {
    activeTurnId: string | undefined;
    terminalId: string;
}): (event: KeyboardEvent<HTMLElement>) => void {
    const { stop } = useAgentChatStop({ activeTurnId, terminalId });
    const isTurnRunning = activeTurnId !== undefined;
    return (event) => {
        if (
            !shouldAgentChatPaneEscapeStop(
                {
                    key: event.key,
                    isComposing: isImeComposing(event),
                    repeat: event.repeat,
                    defaultPrevented: event.defaultPrevented,
                },
                {
                    isTurnRunning,
                    isEditableTarget: isEditable(event.target),
                    isOverlayOpen: document.querySelector(OVERLAY_SELECTOR) !== null,
                },
            )
        )
            return;
        event.preventDefault();
        stop();
    };
}
