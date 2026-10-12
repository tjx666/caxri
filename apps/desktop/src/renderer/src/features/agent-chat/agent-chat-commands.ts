import type {
    AgentChatDefault,
    AgentChatMessageInput,
    AgentChatModelRequest,
    AgentChatRequest,
    AgentChatResponse,
    AgentProvider,
    TerminalRecord,
} from '@caxri/protocol';
import { agentChatAnsweredNotice, formatLongPasteReference } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { getBootstrap } from '../../stores/selectors';
import { pushToast, tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import { didSelectSession } from '../session/session-commands';
import {
    createTerminalForSession,
    RESTART_AGENT_FAILED,
    restartTerminal,
    restartTerminalWithRecovery,
} from '../terminal/terminal-commands';
import { writeAgentChatDraft } from './agent-chat-drafts';
import { agentChatHandoffPrompt } from './agent-chat-handoff';
import { agentChatConfigureFailureMessage } from './agent-chat-model-selection';
import { addAgentChatPendingAnswer, dropAgentChatPendingAnswer } from './agent-chat-pending';
import type { AgentChatRecoveryNotice } from './agent-chat-presentation';
import {
    agentChatForkSuccessMessage,
    agentChatReplaceTurnsConfirm,
    agentChatRestoreSuccessMessage,
} from './agent-chat-rewind-copy';

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
    await tryCommand(translate('agentChat.commands.sendFailed'), async () => {
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
 * Saves a long paste to a local file and returns the reference the message carries in its place, or `undefined` after a
 * toast when it could not be saved. The pasted text itself is never logged.
 */
export function saveAgentChatLongPaste(
    terminalId: string,
    content: string,
): Promise<string | undefined> {
    return tryCommand(translate('agentChat.commands.longPasteFailed'), async () =>
        formatLongPasteReference(
            await caxri.request('agentChat.saveLongPaste', { terminalId, content }),
        ),
    );
}

/**
 * "Edit from here": rewinds the Chat to before message `itemId` and sends `message` in its place. Reverting files first
 * asks for confirmation in a native dialog, since it can discard the user's own edits; replacing more than one turn
 * without reverting files asks in the in-app confirmation (see {@link agentChatReplaceTurnsConfirm}). Declining either
 * sends nothing and keeps the draft. Resolves `true` once Server Core rewound the Chat and accepted the message.
 */
export async function didRewindAgentChat(
    terminalId: string,
    request: {
        itemId: string;
        restoreFiles: boolean;
        message: Omit<AgentChatMessageInput, 'delivery'>;
        providerName: string;
        removedTurns: number;
    },
): Promise<boolean> {
    let isSent = false;
    await tryCommand(translate('agentChat.commands.editFailed'), async () => {
        const replaceTurns = agentChatReplaceTurnsConfirm(request);
        if (replaceTurns && !(await caxri.window.showConfirm(replaceTurns))) return;
        if (request.restoreFiles) {
            const { confirmed } = await caxri.request('agentChat.confirmRevertFiles', {
                providerName: request.providerName,
                removedTurns: request.removedTurns,
            });
            if (!confirmed) return;
        }
        await caxri.request('agentChat.rewind', {
            terminalId,
            itemId: request.itemId,
            restoreFiles: request.restoreFiles,
            ...request.message,
        });
        isSent = true;
    });
    return isSent;
}

/**
 * "Fork from here": copies the conversation before message `itemId` into a Chat in a new Session, puts the message's
 * text in that Chat's composer to send as it is or change first, and opens the Session. The draft is written before the
 * selection so the new composer mounts with it. A toast then says where the conversation went, since the switch to
 * another Session is otherwise the only sign the fork happened.
 */
export async function forkAgentChat(
    terminalId: string,
    itemId: string,
    text: string,
): Promise<void> {
    await tryCommand(translate('agentChat.commands.forkFailed'), async () => {
        const forked = await caxri.request('agentChat.fork', { terminalId, itemId });
        if (text) writeAgentChatDraft(forked.terminalId, text);
        await didSelectSession(forked.sessionId);
        const session = getBootstrap()?.sessions.find(
            (candidate) => candidate.id === forked.sessionId,
        );
        pushToast('success', agentChatForkSuccessMessage(session?.displayTitle));
    });
}

/**
 * "Restore code to here": puts back the files the turns from message `itemId` onward changed and keeps the
 * conversation. It overwrites the user's own edits since, so it asks first in the same native dialog an edit that
 * reverts files uses; Cancel is the default. A success toast confirms it, since the transcript itself does not change.
 */
export async function restoreAgentChatFiles(
    terminalId: string,
    request: { itemId: string; providerName: string; restoredTurns: number },
): Promise<void> {
    await tryCommand(translate('agentChat.commands.restoreFailed'), async () => {
        const { confirmed } = await caxri.request('agentChat.confirmRevertFiles', {
            providerName: request.providerName,
            removedTurns: request.restoredTurns,
        });
        if (!confirmed) return;
        await caxri.request('agentChat.restoreFiles', { terminalId, itemId: request.itemId });
        pushToast('success', agentChatRestoreSuccessMessage(request.restoredTurns));
    });
}

/**
 * Runs one of the provider's slash commands. Resolves `true` once Server Core accepted it.
 */
export async function didRunAgentChatCommand(
    terminalId: string,
    command: { name: string; arguments?: string },
): Promise<boolean> {
    let isRun = false;
    await tryCommand(
        translate('agentChat.commands.runCommandFailed', { name: command.name }),
        async () => {
            await caxri.request('agentChat.runCommand', { terminalId, ...command });
            isRun = true;
        },
    );
    return isRun;
}

export function interruptAgentChat(terminalId: string): void {
    // eslint-disable-next-line no-void -- tryCommand reports interrupt failures through the toast
    void tryCommand(translate('agentChat.commands.stopAgentFailed'), () =>
        caxri.request('agentChat.interrupt', { terminalId }),
    );
}

/**
 * Answers a pending approval or question without waiting for the round trip: the card leaves at once (the dock skips
 * requests with a pending answer), and a question's answers show in the timeline as Server Core will record them. A
 * failed answer reports itself through `tryCommand` and brings the card back.
 */
export async function answerAgentChatRequest(
    terminalId: string,
    request: AgentChatRequest,
    response: AgentChatResponse,
): Promise<void> {
    addAgentChatPendingAnswer(terminalId, {
        requestId: request.id,
        notice:
            response.kind === 'answers'
                ? agentChatAnsweredNotice(request, undefined, response.answers)
                : undefined,
    });
    const isAnswered = await tryCommand(translate('agentChat.commands.answerFailed'), async () => {
        await caxri.request('agentChat.respond', { terminalId, requestId: request.id, response });
        return true;
    });
    if (!isAnswered) dropAgentChatPendingAnswer(terminalId, request.id);
}

/**
 * Switches the model or effort for the next turn onward. Resolves `true` once Server Core accepted the switch; the
 * picker shows the choice as pending until the projection reports it, and drops it when the switch failed. The failure
 * toast names what was being switched.
 */
export async function didConfigureAgentChat(
    terminalId: string,
    change: AgentChatModelRequest,
): Promise<boolean> {
    let isConfigured = false;
    await tryCommand(agentChatConfigureFailureMessage(change), async () => {
        await caxri.request('agentChat.configure', { terminalId, ...change });
        isConfigured = true;
    });
    return isConfigured;
}

/**
 * Saves the level and plan mode new `provider` Chats in the Project start with.
 */
export function saveAgentChatProjectDefault(
    projectId: string,
    provider: AgentProvider,
    chatDefault: AgentChatDefault,
): void {
    // eslint-disable-next-line no-void -- tryCommand reports a failed save through the toast
    void tryCommand(
        translate('agentChat.commands.saveProjectDefaultFailed'),
        () => caxri.request('project.setChatDefault', { projectId, provider, chatDefault }),
        { refresh: refreshWorkbench },
    );
}

/**
 * Stops one subagent or background shell without ending the turn or the Chat.
 */
export function stopAgentChatTask(terminalId: string, taskId: string): void {
    // eslint-disable-next-line no-void -- tryCommand reports stop failures through the toast
    void tryCommand(translate('agentChat.commands.stopTaskFailed'), () =>
        caxri.request('agentChat.stopTask', { terminalId, taskId }),
    );
}

/**
 * Removes a queued message.
 */
export function removeAgentChatQueued(terminalId: string, id: string): void {
    // eslint-disable-next-line no-void -- tryCommand reports failures through the toast
    void tryCommand(translate('agentChat.commands.removeQueuedFailed'), () =>
        caxri.request('agentChat.removeQueued', { terminalId, id }),
    );
}

/**
 * Takes a queued message back for editing and hands its text to `restore` (the composer draft). Server Core removes it
 * and returns the text in one step (`agentChat.takeQueued`), so a message the queue sent meanwhile fails instead of
 * being both sent and back in the draft.
 */
export async function editAgentChatQueued(
    terminalId: string,
    id: string,
    restore: (text: string) => void,
): Promise<void> {
    const taken = await tryCommand(translate('agentChat.commands.editQueuedFailed'), () =>
        caxri.request('agentChat.takeQueued', { terminalId, id }),
    );
    if (taken) restore(taken.text);
}

/**
 * Sends a queued message now: it steers the running turn, or starts one when the Chat is idle.
 */
export function sendAgentChatQueuedNow(terminalId: string, id: string): void {
    // eslint-disable-next-line no-void -- tryCommand reports failures through the toast
    void tryCommand(translate('agentChat.commands.sendQueuedFailed'), () =>
        caxri.request('agentChat.sendQueuedNow', { terminalId, id }),
    );
}

/**
 * Resumes a queue an interrupt paused.
 */
export function resumeAgentChatQueue(terminalId: string): void {
    // eslint-disable-next-line no-void -- tryCommand reports failures through the toast
    void tryCommand(translate('agentChat.commands.resumeQueueFailed'), () =>
        caxri.request('agentChat.resumeQueue', { terminalId }),
    );
}

/**
 * Opens a new Chat of the same Agent in the same Session and sends it {@link agentChatHandoffPrompt}: the manual "start
 * over and point the new conversation at the old transcript" routine for a Chat whose prompt cache expired. Resolves
 * `true` once the new Chat accepted the prompt, so the composer clears the draft it carried over only then.
 */
export async function didContinueAgentChatInNewChat(
    terminal: TerminalRecord,
    { pendingRequest, providerName }: { pendingRequest: string; providerName: string },
): Promise<boolean> {
    const transcript = await tryCommand(translate('agentChat.commands.findTranscriptFailed'), () =>
        caxri.request('terminal.agentTranscript', {
            terminalId: terminal.id,
            withContent: false,
        }),
    );
    if (transcript === undefined) return false;
    if (!transcript?.exists) {
        pushToast('error', translate('agentChat.commands.noTranscript'));
        return false;
    }
    const terminalId = await createTerminalForSession(terminal.sessionId, terminal.kind, {
        surface: 'chat',
    });
    if (!terminalId) return false;
    return didSendAgentChatMessage(terminalId, {
        text: agentChatHandoffPrompt({
            providerName,
            provider: terminal.provider,
            title: terminal.title,
            agentSessionId: terminal.agentSessionId,
            transcriptPath: transcript.path,
            cwd: terminal.agentCwd ?? terminal.cwd,
            pendingRequest,
        }),
    });
}

/**
 * The recovery banner's action: restart a Chat that cannot continue, or read the projection again when only the read
 * failed. Only a hand-over can still have a turn running elsewhere; a failed Chat, or one whose conversation is open in
 * another client, has no turn left to stop, so its Retry restarts without the running-turn confirmation.
 */
export function recoverAgentChat(
    terminalId: string,
    notice: AgentChatRecoveryNotice | undefined,
    refetch: () => Promise<unknown>,
): void {
    if (notice?.recovery === 'restart') {
        if (notice.kind === 'detached') restartTerminal(terminalId);
        else restartTerminalWithRecovery(terminalId, RESTART_AGENT_FAILED);
        return;
    }
    // eslint-disable-next-line no-void -- the query owns the refetch result and error state
    void refetch();
}
