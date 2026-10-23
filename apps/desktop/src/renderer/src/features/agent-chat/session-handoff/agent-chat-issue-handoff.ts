import { AGENT_CHAT_SESSION_HANDOFF_COMMAND } from '@caxri/protocol';

import { translate } from '../../../i18n';
import { getBootstrap } from '../../../stores/selectors';
import { pushToast } from '../../../stores/toasts';
import { cachedAgentChatSnapshot } from '../agent-chat-client';
import { didSendAgentChatMessage } from '../agent-chat-commands';
import {
    dropAgentChatPendingMessage,
    expireAgentChatPendingMessage,
    showAgentChatPendingMessage,
} from '../transcript/agent-chat-pending';
import { agentChatSessionHandoffMessage } from './agent-chat-session-handoff-message';

/**
 * The `/new-session` draft that starts an issue in a new Session: its reference (`ENG-123`, `owner/repo#12`) for the
 * hand-off card and its URL, so the Agent reads the issue itself rather than retelling it from memory.
 */
export function agentChatIssueHandoffDraft(issue: { reference: string; url: string }): string {
    return `/${AGENT_CHAT_SESSION_HANDOFF_COMMAND} Work on ${issue.reference}: ${issue.url}`;
}

/**
 * Sends `draft` (a `/new-session` command) from the Chat as if typed in its composer, without touching the draft the
 * user is writing: the same hand-off instructions, a pending message until Server Core takes it, and the queue while a
 * turn runs. A Chat whose Session or provider is unknown cannot hand off, so it says so instead of sending the bare
 * command.
 */
export async function startAgentChatHandoff(terminalId: string, draft: string): Promise<void> {
    const bootstrap = getBootstrap();
    const terminal = bootstrap?.terminals.find((candidate) => candidate.id === terminalId);
    const text = agentChatSessionHandoffMessage(draft, terminal, bootstrap?.sessions);
    if (text === draft) {
        pushToast('error', translate('agentChat.handoff.unavailable'));
        return;
    }
    const pendingId = showAgentChatPendingMessage(terminalId, cachedAgentChatSnapshot(terminalId), {
        text,
        images: [],
        delivery: undefined,
    });
    if (await didSendAgentChatMessage(terminalId, { text })) {
        expireAgentChatPendingMessage(terminalId, pendingId, cachedAgentChatSnapshot);
    } else {
        dropAgentChatPendingMessage(terminalId, pendingId);
    }
}
