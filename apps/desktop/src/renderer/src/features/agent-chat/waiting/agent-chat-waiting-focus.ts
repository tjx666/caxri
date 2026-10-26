import { createStore } from '../../../lib/store';
import { AGENT_CHAT_APPROVAL_ATTRIBUTE } from '../permissions/agent-chat-approval-commands';

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
 * Where focus lands inside the card: on the answer, not the header's Open Session. That is the question's roving tab
 * stop (its selected option, which the arrow keys then move) or the approval's first decision button; else the first
 * enabled control, else the card itself.
 */
export function agentChatWaitingFocusTarget(card: HTMLElement): HTMLElement {
    return (
        card.querySelector<HTMLElement>(
            '[role="radio"][tabindex="0"], [role="checkbox"][tabindex="0"]',
        ) ??
        card.querySelector<HTMLElement>(
            `[${CSS.escape(AGENT_CHAT_APPROVAL_ATTRIBUTE)}] button:not([disabled])`,
        ) ??
        card.querySelector<HTMLElement>('input:not([disabled]), button:not([disabled])') ??
        card
    );
}

/**
 * Where focus goes once the popup has nothing left to ask: back to what the user left for `Focus Waiting Request`, if
 * it is still in the window and focus is lost (on the body, or still inside the leaving popup). Focus the user already
 * moved elsewhere stays put.
 */
export function agentChatWaitingReturnFocus<Target extends { isConnected: boolean }>(
    returnTo: Target | null,
    isFocusLost: boolean,
): Target | undefined {
    return isFocusLost && returnTo?.isConnected ? returnTo : undefined;
}

interface AgentChatWaitingFoldState {
    /**
     * Requests waiting behind the folded popup; 0 while the popup shows its card or has nothing to ask.
     */
    foldedCount: number;
}

/**
 * The folded waiting popup, which the status bar shows (`AgentChatWaitingChip`) beside the other requests that wait on
 * the user. A pill left floating below the title bar would cover the first line of whatever the active tab shows, a
 * Terminal's prompt or an editor's first line. The popup owns the fold and publishes it here; the chip unfolds it
 * through `unfoldAgentChatWaiting`.
 */
export const useAgentChatWaitingFoldStore = createStore<AgentChatWaitingFoldState>(
    'agent-chat-waiting-fold',
    () => ({ foldedCount: 0 }),
);

const unfoldRegistration: { unfold?: () => void } = {};

/**
 * Registers how the mounted popup unfolds its card; returns the unregister.
 */
export function registerAgentChatWaitingUnfold(unfold: () => void): () => void {
    unfoldRegistration.unfold = unfold;
    return () => {
        if (unfoldRegistration.unfold === unfold) unfoldRegistration.unfold = undefined;
    };
}

export function unfoldAgentChatWaiting(): void {
    unfoldRegistration.unfold?.();
}
