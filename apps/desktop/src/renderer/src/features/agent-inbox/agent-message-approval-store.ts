import type { AgentHeldMessage } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { createStore } from '../../lib/store';
import { describeFailure, pushToast } from '../../stores/toasts';
import { listHeldAgentMessages } from './agent-message-approval-client';
import type { HeldMessageQueue } from './agent-message-approval-state';
import {
    deferredHeldMessages,
    emptyHeldMessageQueue,
    expireHeldMessages,
    receiveHeldMessage,
    removeHeldMessage,
    replaceHeldMessages,
    reviewOldestDeferredHeldMessage,
} from './agent-message-approval-state';

/**
 * How often the queue drops requests whose approval window closed. The Server expires them too, but only a receipt it
 * sends later would say so, and a request past its window must not keep asking for a decision.
 */
const EXPIRY_TICK_MS = 1_000;

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
 * the store untouched, which keeps the one-second expiry tick from notifying every reader when nothing expired.
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
                pushToast('error', describeFailure(error, 'Unable to load held peer messages'));
        }
    }
    // eslint-disable-next-line no-void -- intentional floating-promise discard, loadHeldMessages reports its own failure
    void loadHeldMessages();
    const unsubscribe = caxri.onEvent((event) => {
        if (event.event === 'agent.message.held')
            updateHeldMessageQueue((queue) => receiveHeldMessage(queue, event.payload));
        if (event.event === 'agent.message.receipt' && event.payload.status !== 'held')
            updateHeldMessageQueue((queue) => removeHeldMessage(queue, event.payload.messageId));
    });
    const expiryTimer = setInterval(
        () => updateHeldMessageQueue((queue) => expireHeldMessages(queue, Date.now())),
        EXPIRY_TICK_MS,
    );
    return () => {
        isActive = false;
        unsubscribe();
        clearInterval(expiryTimer);
    };
}
