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

export function decideAgentChatRequest(
    terminalId: string,
    requestId: string,
    decision: AgentChatDecision,
): void {
    // eslint-disable-next-line no-void -- tryCommand reports response failures through the toast
    void tryCommand('Unable to answer the Agent', () =>
        caxri.request('agentChat.respond', {
            terminalId,
            requestId,
            response: { kind: 'decision', decision },
        }),
    );
}

export function answerAgentChatQuestions(
    terminalId: string,
    requestId: string,
    answers: Record<string, string[]>,
): void {
    // eslint-disable-next-line no-void -- tryCommand reports response failures through the toast
    void tryCommand('Unable to answer the Agent', () =>
        caxri.request('agentChat.respond', {
            terminalId,
            requestId,
            response: { kind: 'answers', answers },
        }),
    );
}
