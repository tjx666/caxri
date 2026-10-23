import type { AgentHeldMessage } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { createStore } from '../../lib/store';
import { describeFailure, pushToast } from '../../stores/toasts';
import { listHeldAgentMessages } from './agent-message-approval-client';
import type { HeldMessageQueue } from './agent-message-approval-state';
import {
    deferredHeldMessages,
    emptyHeldMessageQueue,
    expireHeldMessage,
    expireHeldMessages,
    receiveHeldMessage,
    removeHeldMessage,
    replaceHeldMessages,
    reviewOldestDeferredHeldMessage,
} from './agent-message-approval-state';

/**
 * The queue drops a request locally once its approval window closes. The Server expires it too, but only a receipt it
 * sends later would say so, and a request past its window must not keep asking for a decision. One timer aims at the
 * earliest deadline and none runs while the queue is empty, so an idle window never wakes for it.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function earliestExpiry(queue: AgentHeldMessageQueue): number | undefined {
    let earliest: number | undefined;
    for (const message of queue.messages)
        if (earliest === undefined || message.expiresAt < earliest) earliest = message.expiresAt;
    return earliest;
}

type AgentHeldMessageQueue = HeldMessageQueue<AgentHeldMessage>;

interface HeldMessageQueueState {
    queue: AgentHeldMessageQueue;
}

/**
 * The window's single queue of held peer messages. The approval dialog, its waiting list, and the status bar's count
 * all read this one queue, so they can never disagree about which requests are still waiting (issue caxri#1355).
 * {@link subscribeHeldMessageQueue} feeds it from the Server; every user decision goes through
 * {@link updateHeldMessageQueue}.
 */
export const useHeldMessageQueueStore = createStore<HeldMessageQueueState>(
    'agent-message-approval',
    () => ({ queue: emptyHeldMessageQueue }),
);

/**
 * Applies one queue transition from `agent-message-approval-state.ts`. A transition that returns the same queue leaves
 * the store untouched, which keeps an expiry check from notifying every reader when nothing expired.
 */
export function updateHeldMessageQueue(
    transition: (queue: AgentHeldMessageQueue) => AgentHeldMessageQueue,
): void {
    const { queue } = useHeldMessageQueueStore.getState();
    const next = transition(queue);
    if (next !== queue) useHeldMessageQueueStore.setState({ queue: next });
}

/**
 * How many requests the user set aside and has not answered yet.
 */
export function selectDeferredHeldMessageCount(state: HeldMessageQueueState): number {
    return deferredHeldMessages(state.queue).length;
}

/**
 * Reopens the approval dialog on the set-aside request that has waited longest.
 */
export function reviewOldestDeferredMessage(): void {
    updateHeldMessageQueue(reviewOldestDeferredHeldMessage);
}

/**
 * Keeps the queue in step with the Server for the window's lifetime: the current held list once, then every held
 * message and settling receipt as they arrive, plus the expiry tick. Returns the teardown. The App mounts it once,
 * outside every surface that reads the queue, so none of them has to be on screen for the others to stay current.
 */
export function subscribeHeldMessageQueue(): () => void {
    let isActive = true;
    async function loadHeldMessages(): Promise<void> {
        try {
            const initial = await listHeldAgentMessages();
            if (isActive) updateHeldMessageQueue((queue) => replaceHeldMessages(queue, initial));
        } catch (error: unknown) {
            if (isActive)
                pushToast(
                    'error',
                    describeFailure(error, translate('agentInbox.store.loadFailed')),
                );
        }
    }
    // eslint-disable-next-line no-void -- intentional floating-promise discard, loadHeldMessages reports its own failure
    void loadHeldMessages();
    const unsubscribe = caxri.onEvent((event) => {
        if (event.event === 'agent.message.held')
            updateHeldMessageQueue((queue) => receiveHeldMessage(queue, event.payload));
        if (event.event === 'agent.message.receipt' && event.payload.status !== 'held') {
            const { messageId, status } = event.payload;
            // An `expired` receipt is the same event as the local tick below, whichever reports it first.
            updateHeldMessageQueue((queue) =>
                status === 'expired'
                    ? expireHeldMessage(queue, messageId)
                    : removeHeldMessage(queue, messageId),
            );
        }
    });
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let armedExpiry: number | undefined;
    function armExpiry(): void {
        const expiry = earliestExpiry(useHeldMessageQueueStore.getState().queue);
        if (expiry === armedExpiry) return;
        clearTimeout(expiryTimer);
        expiryTimer = undefined;
        armedExpiry = expiry;
        if (expiry === undefined) return;
        // Clamped to the 32-bit timer limit, past which `setTimeout` fires at once and would spin.
        const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, expiry - Date.now()));
        expiryTimer = setTimeout(() => {
            armedExpiry = undefined;
            updateHeldMessageQueue((queue) => expireHeldMessages(queue, Date.now()));
            armExpiry();
        }, delay);
    }
    /**
     * A timer does not advance while the Mac sleeps, so a deadline that passed during sleep is checked on return.
     */
    function expireOnReturn(): void {
        updateHeldMessageQueue((queue) => expireHeldMessages(queue, Date.now()));
    }
    const unsubscribeExpiry = useHeldMessageQueueStore.subscribe(armExpiry);
    armExpiry();
    // Absent only in node-environment unit tests.
    const view = 'window' in globalThis ? globalThis : undefined;
    view?.addEventListener('focus', expireOnReturn);
    view?.document.addEventListener('visibilitychange', expireOnReturn);
    return () => {
        isActive = false;
        unsubscribe();
        unsubscribeExpiry();
        clearTimeout(expiryTimer);
        view?.removeEventListener('focus', expireOnReturn);
        view?.document.removeEventListener('visibilitychange', expireOnReturn);
    };
}
