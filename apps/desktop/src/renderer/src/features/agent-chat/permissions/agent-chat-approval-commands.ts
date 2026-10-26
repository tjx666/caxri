import type { AgentChatKeyTarget } from './agent-chat-approval-keys';
import { agentChatApprovalKeyOwner } from './agent-chat-approval-keys';

/**
 * The attribute the Chat pane carries, so an approval card can be found from anywhere in its own pane.
 */
export const AGENT_CHAT_PANE_ATTRIBUTE = 'data-agent-chat-pane';

/**
 * The attribute every approval card carries; only the first one in a pane answers to the keys.
 */
export const AGENT_CHAT_APPROVAL_ATTRIBUTE = 'data-agent-chat-approval';

/**
 * Marks the waiting popup's card, the one approval a key may answer from outside any Chat pane.
 */
const AGENT_CHAT_WAITING_CARD_SELECTOR = '[data-agent-chat-waiting="card"]';

export type AgentChatApprovalDecision = 'accept' | 'decline';

interface AgentChatApprovalRegistration {
    answer: (decision: AgentChatApprovalDecision) => void;
    /**
     * The `performance.now()` time before which a key does nothing, so a press meant for the previous card cannot
     * answer one that just dropped in (the waiting popup's 450ms arm delay).
     */
    armedAt: number;
}

/**
 * The bridge between the `agentChat.allowRequest` / `agentChat.denyRequest` commands and the mounted approval cards,
 * keyed by card element so the DOM decides which card focus is nearest to.
 */
const registrations = new Map<Element, AgentChatApprovalRegistration>();

/**
 * Registers what answering this approval card from the keyboard does; returns the unregister.
 */
export function registerAgentChatApproval(
    card: Element,
    registration: AgentChatApprovalRegistration,
): () => void {
    registrations.set(card, registration);
    return () => {
        if (registrations.get(card) === registration) registrations.delete(card);
    };
}

function keyTarget(element: HTMLElement | null): AgentChatKeyTarget | null {
    return (
        element && {
            isContentEditable: element.isContentEditable,
            role: element.getAttribute('role'),
            tagName: element.tagName,
            value: (element as { value?: unknown }).value,
        }
    );
}

/**
 * The card a key press would answer with focus where it is now (see `agentChatApprovalKeyOwner`). A key reaches the
 * focused element, so `document.activeElement` is the press's target.
 */
function focusedApproval(): AgentChatApprovalRegistration | undefined {
    const active = document.activeElement;
    // Nothing focused reports the body, which is no text field.
    const focused = active instanceof HTMLElement && active !== document.body ? active : null;
    const approvalSelector = `[${CSS.escape(AGENT_CHAT_APPROVAL_ATTRIBUTE)}]`;
    const pane = focused?.closest(`[${CSS.escape(AGENT_CHAT_PANE_ATTRIBUTE)}]`);
    const paneCard = pane?.querySelector(approvalSelector);
    const owner = agentChatApprovalKeyOwner(
        keyTarget(focused),
        pane ? (paneCard ? 'withApproval' : 'withoutApproval') : 'none',
    );
    const card =
        owner === 'pane'
            ? paneCard
            : owner === 'popup'
              ? document.querySelector(`${AGENT_CHAT_WAITING_CARD_SELECTOR} ${approvalSelector}`)
              : null;
    return card ? registrations.get(card) : undefined;
}

export function canAnswerAgentChatApproval(): boolean {
    return focusedApproval() !== undefined;
}

/**
 * Answers the approval focus is nearest to. A card still inside its arm delay swallows the key without answering.
 */
export function answerAgentChatApproval(decision: AgentChatApprovalDecision): void {
    const approval = focusedApproval();
    if (!approval || performance.now() < approval.armedAt) return;
    approval.answer(decision);
}
