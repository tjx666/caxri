import type {
    AgentChatDecision,
    AgentChatMessageInput,
    AgentChatModelRequest,
} from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';

/**
 * Sends a message. An idle Chat starts a turn; while a turn runs, `delivery` decides whether the message waits in the
 * queue (the default) or steers the running turn. Resolves `true` once Server Core accepted it, so the composer clears
 * its draft only for a message that was actually delivered.
 */
export async function didSendAgentChatMessage(
    terminalId: string,
    message: AgentChatMessageInput,
    delivery?: 'queue' | 'steer',
): Promise<boolean> {
    let isSent = false;
    await tryCommand('Message could not be sent', async () => {
        await caxri.request('agentChat.send', {
            terminalId,
            ...message,
            ...(delivery && { delivery }),
        });
        isSent = true;
    });
    return isSent;
}

/**
 * Runs one of the provider's slash commands. Resolves `true` once Server Core accepted it.
 */
export async function didRunAgentChatCommand(
    terminalId: string,
    command: { name: string; arguments?: string },
): Promise<boolean> {
    let isRun = false;
    await tryCommand(`/${command.name} could not run`, async () => {
        await caxri.request('agentChat.runCommand', { terminalId, ...command });
        isRun = true;
    });
    return isRun;
}

export function interruptAgentChat(terminalId: string): void {
    // eslint-disable-next-line no-void -- tryCommand reports interrupt failures through the toast
    void tryCommand('Unable to stop the Agent', () =>
        caxri.request('agentChat.interrupt', { terminalId }),
    );
}

/**
 * Answers a pending approval or question. Resolves `true` once Server Core accepted the answer; the request card then
 * waits for the projection to remove it, and re-enables its controls only when the answer failed.
 */
export async function didAnswerAgentChatRequest(
    terminalId: string,
    requestId: string,
    response:
        | { kind: 'decision'; decision: AgentChatDecision }
        | { kind: 'answers'; answers: Record<string, string[]> },
): Promise<boolean> {
    let isAnswered = false;
    await tryCommand('Unable to answer the Agent', async () => {
        await caxri.request('agentChat.respond', { terminalId, requestId, response });
        isAnswered = true;
    });
    return isAnswered;
}

/**
 * Switches the model or effort for the next turn onward. The picker reflects the change once the projection reports it,
 * so a failed switch leaves the old choice visible.
 */
export function configureAgentChat(terminalId: string, change: AgentChatModelRequest): void {
    // eslint-disable-next-line no-void -- tryCommand reports a failed switch through the toast
    void tryCommand('Unable to switch the model', () =>
        caxri.request('agentChat.configure', { terminalId, ...change }),
    );
}

/**
 * Stops one subagent or background shell without ending the turn or the Chat.
 */
export function stopAgentChatTask(terminalId: string, taskId: string): void {
    // eslint-disable-next-line no-void -- tryCommand reports stop failures through the toast
    void tryCommand('Unable to stop the task', () =>
        caxri.request('agentChat.stopTask', { terminalId, taskId }),
    );
}

/**
 * Removes a queued message. Resolves `true` once it left the queue, so Edit moves its text into the composer only when
 * Server Core will not also send it.
 */
export async function didRemoveAgentChatQueued(terminalId: string, id: string): Promise<boolean> {
    let isRemoved = false;
    await tryCommand('Unable to remove the queued message', async () => {
        await caxri.request('agentChat.removeQueued', { terminalId, id });
        isRemoved = true;
    });
    return isRemoved;
}

/**
 * Takes a queued message back for editing: removes it from the queue, then hands its text to `restore` (the composer
 * draft). Nothing is restored when the message already left the queue, so it is never both sent and back in the draft.
 */
export async function editAgentChatQueued(
    terminalId: string,
    entry: { id: string; editText: string },
    restore: (text: string) => void,
): Promise<void> {
    if (await didRemoveAgentChatQueued(terminalId, entry.id)) restore(entry.editText);
}

/**
 * Sends a queued message now: it steers the running turn, or starts one when the Chat is idle.
 */
export function sendAgentChatQueuedNow(terminalId: string, id: string): void {
    // eslint-disable-next-line no-void -- tryCommand reports failures through the toast
    void tryCommand('Unable to send the queued message', () =>
        caxri.request('agentChat.sendQueuedNow', { terminalId, id }),
    );
}

/**
 * Resumes a queue an interrupt paused.
 */
export function resumeAgentChatQueue(terminalId: string): void {
    // eslint-disable-next-line no-void -- tryCommand reports failures through the toast
    void tryCommand('Unable to resume the queue', () =>
        caxri.request('agentChat.resumeQueue', { terminalId }),
    );
}
