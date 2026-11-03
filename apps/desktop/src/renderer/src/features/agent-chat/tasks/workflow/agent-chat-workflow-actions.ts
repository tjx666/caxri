import { translate } from '../../../../i18n';
import { writeClipboardText } from '../../../../lib/clipboard';
import { pushToast, tryCommand } from '../../../../stores/toasts';
import { appendToAgentChatDraft } from '../../composer-input/agent-chat-drafts';
import { revealAgentChat } from '../agent-chat-task-opener';
import { agentChatWorkflowResumeDraft } from './agent-chat-workflow';

/**
 * "Ask the Agent to continue" on an interrupted run: puts the resume request in the Chat's draft and brings its
 * composer forward. Nothing is sent; the user reads and sends it, since resuming spends their quota.
 */
export function resumeAgentChatWorkflow(
    terminalId: string,
    name: string,
    runId: string | undefined,
): void {
    appendToAgentChatDraft(terminalId, agentChatWorkflowResumeDraft(name, runId));
    revealAgentChat(terminalId);
}

/**
 * Copies a failed script's error, for pasting into an issue or back into the Chat.
 */
export function copyAgentChatWorkflowError(error: string): void {
    void tryCommand(translate('agentChat.userMenu.copyFailed'), async () => {
        await writeClipboardText(error);
        pushToast('success', translate('agentChat.workflow.errorCopied'));
    });
}
