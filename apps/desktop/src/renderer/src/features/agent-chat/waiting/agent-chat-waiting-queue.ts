import type { AgentChatPendingAnswer, AgentChatWaitingEntry } from '@caxri/protocol';
import { agentChatProposedPlanRequest } from '@caxri/protocol';

/**
 * When each waiting Chat or PTY Terminal first reached this window, as an arrival sequence: the popup asks the oldest
 * first, so a Chat that starts waiting later never jumps ahead of one the user is about to answer.
 */
export type AgentChatWaitingArrivals = ReadonlyMap<string, number>;

/**
 * The arrival order after a fresh read: Chats still waiting keep their place, new ones join at the back in the order
 * Server Core lists them, and Chats that stopped waiting are forgotten, so one that asks again later counts as new.
 */
export function nextAgentChatWaitingArrivals(
    previous: AgentChatWaitingArrivals,
    chats: ReadonlyArray<Pick<AgentChatWaitingEntry, 'terminalId'>>,
): AgentChatWaitingArrivals {
    let sequence = Math.max(0, ...previous.values());
    const next = new Map<string, number>();
    for (const { terminalId } of chats)
        next.set(terminalId, previous.get(terminalId) ?? (sequence += 1));
    const isSame =
        next.size === previous.size &&
        [...next].every(([terminalId, order]) => previous.get(terminalId) === order);
    return isSame ? previous : next;
}

interface AgentChatWaitingFilter {
    arrivals: AgentChatWaitingArrivals;
    /**
     * Per Terminal, the proposed plan item whose approval the user dismissed with Keep Planning; its request leaves.
     */
    dismissedPlans?: Readonly<Record<string, string | undefined>>;
    /**
     * Answers sent from this window whose request Server Core still lists, per Terminal; those requests leave at once.
     */
    answers: Readonly<Record<string, readonly AgentChatPendingAnswer[] | undefined>>;
    /**
     * A Chat on screen in this window asks through its own pane, and a PTY Terminal on screen shows its own prompt, so
     * the popup leaves both out.
     */
    isOnScreen: (terminalId: string) => boolean;
    /**
     * Whether this window knows the Session, so the card can name it; a Session it has not loaded yet waits for the
     * next Workbench snapshot instead of showing a nameless card.
     */
    isKnownSession: (sessionId: string) => boolean;
}

/**
 * The entries the popup asks about, oldest arrival first. A Chat holds only the requests nobody has answered yet; a PTY
 * Terminal entry has none to answer and leaves once its Terminal is on screen or the Agent stops waiting.
 */
export function agentChatWaitingQueue(
    chats: readonly AgentChatWaitingEntry[],
    { answers, arrivals, dismissedPlans = {}, isKnownSession, isOnScreen }: AgentChatWaitingFilter,
): AgentChatWaitingEntry[] {
    const queue: AgentChatWaitingEntry[] = [];
    for (const chat of chats) {
        if (isOnScreen(chat.terminalId) || !isKnownSession(chat.sessionId)) continue;
        if (chat.kind === 'terminal') {
            queue.push(chat);
            continue;
        }
        const answered = answers[chat.terminalId] ?? [];
        const dismissedPlan = dismissedPlans[chat.terminalId];
        const requests = chat.requests.filter(
            (request) =>
                answered.every((answer) => answer.requestId !== request.id) &&
                (dismissedPlan === undefined ||
                    request.id !== agentChatProposedPlanRequest(dismissedPlan).id),
        );
        if (requests.length === 0) continue;
        queue.push(requests.length === chat.requests.length ? chat : { ...chat, requests });
    }
    const order = (terminalId: string): number => arrivals.get(terminalId) ?? Infinity;
    return queue.toSorted((left, right) => order(left.terminalId) - order(right.terminalId));
}

/**
 * Every request the popup still has to ask, across all its entries: the pill's count. A PTY Terminal counts as one.
 */
export function agentChatWaitingRequestCount(queue: readonly AgentChatWaitingEntry[]): number {
    return queue.reduce(
        (count, chat) => count + (chat.kind === 'chat' ? chat.requests.length : 1),
        0,
    );
}

/**
 * Whether the popup shows its card or folds into the pill, and the request count that decision saw.
 */
export interface AgentChatWaitingView {
    isCollapsed: boolean;
    count: number;
}

/**
 * The view after the count changes. A new request unfolds the card even if the user folded it, because a fold means
 * "not this one now", not "never tell me again"; an answered one keeps the user's choice. Once nothing is left the fold
 * resets, so the next request arrives as a card.
 */
export function nextAgentChatWaitingView(
    view: AgentChatWaitingView,
    count: number,
): AgentChatWaitingView {
    if (count === view.count) return view;
    if (count === 0 || count > view.count) return { isCollapsed: false, count };
    return { isCollapsed: view.isCollapsed, count };
}
