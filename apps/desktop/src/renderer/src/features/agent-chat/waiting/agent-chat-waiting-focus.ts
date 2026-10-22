/**
 * The waiting popup's way in for the keyboard. The popup never takes focus by itself, so a user who wants to answer it
 * without the mouse runs `agentChat.focusWaitingRequest`; this module is the bridge between that command and the
 * mounted popup, the way `agent-chat-composer-commands.ts` reaches a composer control.
 */
const registration: { handler?: () => void } = {};

/**
 * Registers what focusing the popup does while it has a request to show; returns the unregister.
 */
export function registerAgentChatWaitingFocus(run: () => void): () => void {
    registration.handler = run;
    return () => {
        if (registration.handler === run) registration.handler = undefined;
    };
}

export function canFocusAgentChatWaiting(): boolean {
    return registration.handler !== undefined;
}

export function focusAgentChatWaiting(): void {
    registration.handler?.();
}

/**
 * Where focus lands inside the card: the question's roving tab stop (its selected option, which the arrow keys then
 * move), else the first enabled control, else the card itself.
 */
export function agentChatWaitingFocusTarget(card: HTMLElement): HTMLElement {
    return (
        card.querySelector<HTMLElement>(
            '[role="radio"][tabindex="0"], [role="checkbox"][tabindex="0"]',
        ) ??
        card.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled])') ??
        card
    );
}
