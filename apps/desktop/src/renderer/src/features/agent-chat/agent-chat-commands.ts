import type { AgentChatDecision } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { tryCommand } from '../../stores/toasts';

/**
 * Sends a message, starting a turn or steering the running one. Resolves `true` once Server Core accepted it, so the
 * composer clears its draft only for a message that was actually delivered.
 */
export async function didSendAgentChatMessage(terminalId: string, text: string): Promise<boolean> {
    let isSent = false;
    await tryCommand('Message could not be sent', async () => {
        await caxri.request('agentChat.send', { terminalId, text });
        isSent = true;
    });
    return isSent;
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
