import { CaxriError } from '@caxri/protocol';

import { requireChatTerminal } from './chat-launch';
import type { ChatFollowUpQueue } from './chat-queue';
import type { ChatStateDelivery, ChatStates } from './chat-states';
import type { AgentChatServiceOptions } from './service-options';

/**
 * What the queue card's actions need from the Chat service: the Terminal record to check it is a Chat, the live Chat
 * states that own each queue, and the per-Chat input chain a send-now joins.
 */
export interface ChatQueueActionsHost {
    options: Pick<AgentChatServiceOptions, 'database'>;
    states: ChatStates;
    enqueue(terminalId: string, deliver: ChatStateDelivery): Promise<void>;
}

/**
 * A Chat without live state has nothing queued, so an action on one of its entries is a `CONFLICT`.
 */
function queueOf(host: ChatQueueActionsHost, terminalId: string): ChatFollowUpQueue {
    requireChatTerminal(host.options.database, terminalId);
    const state = host.states.get(terminalId);
    if (!state) throw new CaxriError('CONFLICT', 'This message is no longer queued');
    return state.followUps;
}

/**
 * The queue card's Delete.
 */
export function removeQueued(host: ChatQueueActionsHost, terminalId: string, id: string): void {
    queueOf(host, terminalId).remove(id, 'removed');
}

/**
 * The queue card's Edit: takes a queued message back and returns its full text; see `ChatFollowUpQueue.takeForEdit`.
 */
export function takeQueued(
    host: ChatQueueActionsHost,
    terminalId: string,
    id: string,
): { text: string } {
    return queueOf(host, terminalId).takeForEdit(id);
}

/**
 * Sends one queued message ahead of the rest: it steers the running turn, or starts a turn when the Chat is idle.
 */
export async function sendQueuedNow(
    host: ChatQueueActionsHost,
    terminalId: string,
    id: string,
): Promise<void> {
    await host.enqueue(terminalId, async (session, state) => {
        const entry = state.followUps.entry(id);
        const isSteering = Boolean(state.projection.snapshot.activeTurnId);
        if (isSteering && entry.kind === 'command')
            throw new CaxriError('CONFLICT', 'A command cannot join a running turn');
        await state.followUps.sendNow(session, id, isSteering ? 'steered' : 'queued');
    });
}

/**
 * The queue header's Resume. A Chat without live state has no paused queue to resume.
 */
export function resumeQueue(host: ChatQueueActionsHost, terminalId: string): void {
    requireChatTerminal(host.options.database, terminalId);
    host.states.get(terminalId)?.followUps.resume();
}
