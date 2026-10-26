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
    queueOf(host, terminalId).removeForUndo(id);
}

/**
 * The Undo of the queue card's Delete: puts the entry back in its place.
 */
export function restoreQueued(host: ChatQueueActionsHost, terminalId: string, id: string): void {
    queueOf(host, terminalId).restoreRemoved(id);
}

/**
 * The queue card's Edit of a message with images: rewrites its text in place and keeps the images.
 */
export function editQueued(
    host: ChatQueueActionsHost,
    terminalId: string,
    id: string,
    text: string,
): void {
    queueOf(host, terminalId).editText(id, text);
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
    host.states.assertUsage(terminalId, 'chat_queue');
    await host.enqueue(terminalId, async (session, state) => {
        const entry = state.followUps.entry(id);
        const isSteering = Boolean(state.projection.snapshot.activeTurnId);
        if (isSteering && entry.kind === 'command')
            throw new CaxriError('CONFLICT', 'A command cannot join a running turn');
        await state.followUps.sendNow(session, id, isSteering ? 'steered' : 'queued');
    });
}

/**
 * The queue header's Resume; true when it released queued inputs. A Chat without live state has no paused queue to
 * resume.
 */
export function didResumeQueue(host: ChatQueueActionsHost, terminalId: string): boolean {
    requireChatTerminal(host.options.database, terminalId);
    host.states.assertUsage(terminalId, 'chat_queue');
    return host.states.get(terminalId)?.followUps.resume() ?? false;
}
