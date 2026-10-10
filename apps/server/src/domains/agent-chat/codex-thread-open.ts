import { isRecord, stringField } from './chat-items';
import type { ChatProcessEnd } from './chat-provider';
import { AgentChatStartError } from './chat-provider';
import type { CodexThreadSettings } from './codex-chat-types';
import type { CodexConnection } from './codex-connection';
import { CodexRequestError } from './codex-connection';

/**
 * Opening a Codex Chat: the app-server handshake, then resuming the bound thread or starting a new one. Every failure
 * closes the connection and rejects with an {@link AgentChatStartError} carrying a closed reason.
 */

type Json = Record<string, unknown>;

const HANDSHAKE_TIMEOUT_MS = 15_000;
const THREAD_OPEN_TIMEOUT_MS = 30_000;

/**
 * `initialize` and `initialized`. `spawnFailure` reports how the process ended if it never started, which explains a
 * failed handshake better than the handshake error does.
 */
export async function initializeCodexConnection(
    connection: CodexConnection,
    clientVersion: string,
    spawnFailure: () => ChatProcessEnd | undefined,
): Promise<void> {
    try {
        await connection.request(
            'initialize',
            {
                clientInfo: { name: 'caxri', title: 'Caxri', version: clientVersion },
                capabilities: {
                    /**
                     * Required for `thread/backgroundTerminals/*`. It also adds experimental fields and notifications
                     * (`thread/queue/changed`, `thread/readState/changed`, ...), which the loose parsing here ignores.
                     */
                    experimentalApi: true,
                    optOutNotificationMethods: [
                        'turn/diff/updated',
                        'item/reasoning/textDelta',
                        'item/fileChange/outputDelta',
                        'item/plan/delta',
                    ],
                },
            },
            HANDSHAKE_TIMEOUT_MS,
        );
        connection.notify('initialized');
    } catch (error) {
        await connection.close();
        const failure = spawnFailure();
        if (failure?.reason === 'spawnFailed')
            throw failure.code === 'ENOENT'
                ? new AgentChatStartError('executable_not_found', 'Codex CLI was not found')
                : new AgentChatStartError('spawn_failed', 'Codex could not be started');
        if (error instanceof CodexRequestError && /unknown variant/u.test(error.message))
            throw new AgentChatStartError(
                'unsupported_version',
                'This Codex CLI version does not support Chat',
            );
        throw new AgentChatStartError(
            'handshake_failed',
            'Codex app-server did not complete its handshake',
        );
    }
}

export type CodexThreadOpening =
    | { outcome: 'resumed'; thread: Json; model?: string }
    | { outcome: 'started'; threadId: string; model?: string };

/**
 * Resumes `threadId` with its history, or starts a new thread when there is none.
 */
export async function openCodexThread(
    connection: CodexConnection,
    { cwd, settings, threadId }: { cwd: string; settings: CodexThreadSettings; threadId?: string },
): Promise<CodexThreadOpening> {
    const threadParameters = {
        cwd,
        approvalPolicy: settings.approvalPolicy,
        approvalsReviewer: 'user',
        sandbox: settings.sandbox,
        config: { 'tools.update_plan.enabled': true },
    };
    if (threadId) {
        let result: unknown;
        try {
            /**
             * `model` is omitted on purpose: naming one would override the thread's own saved model and effort.
             */
            result = await connection.request(
                'thread/resume',
                { ...threadParameters, threadId },
                THREAD_OPEN_TIMEOUT_MS,
            );
        } catch {
            await connection.close();
            throw new AgentChatStartError(
                'resume_failed',
                'Codex could not resume this conversation',
            );
        }
        const thread = isRecord(result) && isRecord(result.thread) ? result.thread : undefined;
        if (thread?.id !== threadId) {
            await connection.close();
            throw new AgentChatStartError(
                'resume_failed',
                'Codex resumed a different conversation',
            );
        }
        const model = isRecord(result) ? stringField(result.model) : undefined;
        return { outcome: 'resumed', thread, ...(model && { model }) };
    }
    let result: unknown;
    try {
        result = await connection.request(
            'thread/start',
            { ...threadParameters, ...(settings.model && { model: settings.model }) },
            THREAD_OPEN_TIMEOUT_MS,
        );
    } catch {
        await connection.close();
        throw new AgentChatStartError('handshake_failed', 'Codex could not start a conversation');
    }
    const thread = isRecord(result) && isRecord(result.thread) ? result.thread : undefined;
    const startedId = stringField(thread?.id);
    if (!startedId) {
        await connection.close();
        throw new AgentChatStartError('handshake_failed', 'Codex did not return a conversation');
    }
    const model = isRecord(result) ? stringField(result.model) : undefined;
    return { outcome: 'started', threadId: startedId, ...(model && { model }) };
}
