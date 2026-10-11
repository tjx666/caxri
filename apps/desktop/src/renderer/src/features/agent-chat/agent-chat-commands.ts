import type {
    AgentChatDecision,
    AgentChatDefault,
    AgentChatMessageInput,
    AgentChatModelRequest,
    AgentChatPermissionRequest,
    AgentProvider,
    TerminalRecord,
} from '@caxri/protocol';
import { formatLongPasteReference } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { pushToast, tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import { didSelectSession } from '../session/session-commands';
import { createTerminalForSession } from '../terminal/terminal-commands';
import { writeAgentChatDraft } from './agent-chat-drafts';
import { agentChatHandoffPrompt } from './agent-chat-handoff';

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
 * Saves a long paste to a local file and returns the reference the message carries in its place, or `undefined` after a
 * toast when it could not be saved. The pasted text itself is never logged.
 */
export function saveAgentChatLongPaste(
    terminalId: string,
    content: string,
): Promise<string | undefined> {
    return tryCommand("Long paste couldn't be saved", async () =>
        formatLongPasteReference(
            await caxri.request('agentChat.saveLongPaste', { terminalId, content }),
        ),
    );
}

/**
 * "Edit from here": rewinds the Chat to before message `itemId` and sends `message` in its place. Reverting files first
 * asks for confirmation in a native dialog, since it can discard the user's own edits; declining sends nothing and
 * keeps the draft. Resolves `true` once Server Core rewound the Chat and accepted the message.
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
    await tryCommand('Message could not be edited', async () => {
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
 * selection so the new composer mounts with it.
 */
export async function forkAgentChat(
    terminalId: string,
    itemId: string,
    text: string,
): Promise<void> {
    await tryCommand('Conversation could not be forked', async () => {
        const forked = await caxri.request('agentChat.fork', { terminalId, itemId });
        if (text) writeAgentChatDraft(forked.terminalId, text);
        await didSelectSession(forked.sessionId);
    });
}

/**
 * "Restore code to here": puts back the files the turns from message `itemId` onward changed and keeps the
 * conversation. It overwrites the user's own edits since, so it asks first in the same native dialog an edit that
 * reverts files uses; Cancel is the default.
 */
export async function restoreAgentChatFiles(
    terminalId: string,
    request: { itemId: string; providerName: string; restoredTurns: number },
): Promise<void> {
    await tryCommand('Code could not be restored', async () => {
        const { confirmed } = await caxri.request('agentChat.confirmRevertFiles', {
            providerName: request.providerName,
            removedTurns: request.restoredTurns,
        });
        if (!confirmed) return;
        await caxri.request('agentChat.restoreFiles', { terminalId, itemId: request.itemId });
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
 * Switches the Chat's permission level or plan mode. Grok Build restarts on the same conversation to apply a level, and
 * refuses while a turn runs; the toast reports that.
 */
export function configureAgentChatPermission(
    terminalId: string,
    change: AgentChatPermissionRequest,
): void {
    // eslint-disable-next-line no-void -- tryCommand reports a failed switch through the toast
    void tryCommand('Unable to change permissions', () =>
        caxri.request('agentChat.configure', { terminalId, ...change }),
    );
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
        'Unable to save the Project default',
        () => caxri.request('project.setChatDefault', { projectId, provider, chatDefault }),
        { refresh: refreshWorkbench },
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

/**
 * Opens a new Chat of the same Agent in the same Session and sends it {@link agentChatHandoffPrompt}: the manual "start
 * over and point the new conversation at the old transcript" routine for a Chat whose prompt cache expired. Resolves
 * `true` once the new Chat accepted the prompt, so the composer clears the draft it carried over only then.
 */
export async function didContinueAgentChatInNewChat(
    terminal: TerminalRecord,
    { pendingRequest, providerName }: { pendingRequest: string; providerName: string },
): Promise<boolean> {
    const transcript = await tryCommand('Unable to find the transcript', () =>
        caxri.request('terminal.agentTranscript', {
            terminalId: terminal.id,
            withContent: false,
        }),
    );
    if (transcript === undefined) return false;
    if (!transcript?.exists) {
        pushToast('error', 'This Chat has no transcript on disk for a new Chat to read.');
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
