import { getSelectedSession } from '../../stores/selectors';
import { openAgentChatTaskTab } from '../agent-chat/tasks/agent-chat-task-opener';
import { didSelectSession } from '../session/session-commands';

/**
 * Opens a subagent from its sidebar row: the Session comes first, because the task tab opens beside the selected
 * Session's Chat (the same select-then-open order as the pending review comments entry). A failed selection already
 * toasted, so nothing opens.
 */
export async function openSessionSubagent(
    sessionId: string,
    terminalId: string,
    taskId: string,
): Promise<void> {
    if (getSelectedSession()?.id !== sessionId && !(await didSelectSession(sessionId))) return;
    openAgentChatTaskTab(terminalId, taskId);
}
