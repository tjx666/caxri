import { isRecord, stringField } from './chat-items';
import type { ChatProcessEnd } from './chat-provider';
import { AgentChatStartError } from './chat-provider';
import type { CodexThreadSettings } from './codex-chat-types';
import type { JsonRpcConnection } from './json-rpc-connection';
import { JsonRpcRequestError } from './json-rpc-connection';

/**
 * Opening a Codex Chat: the app-server handshake, then resuming the bound thread or starting a new one. Every failure
 * closes the connection and rejects with an {@link AgentChatStartError} carrying a closed reason.
 */

type Json = Record<string, unknown>;

const HANDSHAKE_TIMEOUT_MS = 15_000;
const THREAD_OPEN_TIMEOUT_MS = 30_000;

type CodexRequest = (method: string, parameters: unknown, timeoutMs?: number) => Promise<unknown>;

/**
 * The largest `thread/turns/list` page Codex serves (`THREAD_TURNS_MAX_LIMIT` in codex-rs app-server).
 */
const TURNS_PAGE_LIMIT = 100;

/**
 * Every turn of a thread opened or read without its turns, oldest first, each with all of its items.
 *
 * Codex stores newer threads as paginated history (`historyMode: "paginated"`) and answers a full-history
 * `thread/resume`, `thread/fork`, or `thread/read` of one with a `deprecationNotice` the Chat would show to the user.
 * Those threads are paged with `thread/turns/list`, as Codex's own TUI does. A legacy thread is read whole with
 * `thread/read` instead: Codex rebuilds a legacy thread from its whole rollout for every `thread/turns/list` page.
 */
export async function readCodexThreadTurns(
    request: CodexRequest,
    thread: Json,
    timeoutMs: number,
): Promise<unknown[]> {
    const threadId = stringField(thread.id);
    if (thread.historyMode !== 'paginated') {
        const result = await request('thread/read', { threadId, includeTurns: true }, timeoutMs);
        const read = isRecord(result) && isRecord(result.thread) ? result.thread : undefined;
        if (!read || read.id !== threadId) throw new Error('Codex read a different thread');
        return Array.isArray(read.turns) ? (read.turns as unknown[]) : [];
    }
    const turns: unknown[] = [];
    let cursor: string | undefined;
    do {
        // eslint-disable-next-line no-await-in-loop -- each page's cursor comes from the previous page
        const result = await request(
            'thread/turns/list',
            {
                threadId,
                limit: TURNS_PAGE_LIMIT,
                sortDirection: 'asc',
                itemsView: 'full',
                ...(cursor && { cursor }),
            },
            timeoutMs,
        );
        if (!isRecord(result) || !Array.isArray(result.data))
            throw new Error('Codex returned no turns page');
        const page = result.data as unknown[];
        turns.push(...page);
        const next = stringField(result.nextCursor);
        // A cursor that does not advance would page forever.
        cursor = next !== cursor && page.length > 0 ? next : undefined;
    } while (cursor);
    return turns;
}

/**
 * `initialize` and `initialized`. `spawnFailure` reports how the process ended if it never started, which explains a
 * failed handshake better than the handshake error does.
 */
export async function initializeCodexConnection(
    connection: JsonRpcConnection,
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
        if (error instanceof JsonRpcRequestError && /unknown variant/u.test(error.message))
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

/**
 * What Codex reported for the opened thread: its model, reasoning effort, service tier, and collaboration mode. A
 * thread that never chose an effort or service tier reports none.
 */
interface CodexThreadReport {
    model?: string;
    effort?: string;
    serviceTier?: string;
    collaborationMode?: string;
}

/**
 * The opened thread, with what Codex reported for it.
 */
export type CodexThreadOpening = CodexThreadReport &
    ({ outcome: 'resumed'; thread: Json } | { outcome: 'started'; threadId: string });

function reportedModel(result: unknown): CodexThreadReport {
    if (!isRecord(result)) return {};
    const model = stringField(result.model);
    const effort = stringField(result.reasoningEffort);
    const serviceTier = stringField(result.serviceTier);
    const collaborationMode = isRecord(result.collaborationMode)
        ? stringField(result.collaborationMode.mode)
        : undefined;
    return {
        ...(model && { model }),
        ...(effort && { effort }),
        ...(serviceTier && { serviceTier }),
        ...(collaborationMode && { collaborationMode }),
    };
}

/**
 * Codex lets one process write a thread at a time. A thread still open in another client (the Codex app, a `codex` TUI,
 * another Caxri profile) fails `thread/resume` with `thread <id> already has an active writer` until that client
 * releases it, so this is a recoverable conflict rather than a lost conversation.
 */
function isThreadWriterConflict(error: unknown): boolean {
    return (
        error instanceof JsonRpcRequestError && /already has an active writer/u.test(error.message)
    );
}

const CONFIG_READ_TIMEOUT_MS = 10_000;

/**
 * Caxri's instructions joined after the user's own `developer_instructions`. The thread's `developerInstructions`
 * replaces the configured value instead of adding to it, so the configured value is read first with `config/read`. A
 * Codex that cannot report it gets nothing from Caxri rather than losing the user's instructions.
 */
async function developerInstructions(
    connection: JsonRpcConnection,
    cwd: string,
    instructions: string | undefined,
): Promise<string | undefined> {
    if (!instructions) return undefined;
    let result: unknown;
    try {
        result = await connection.request('config/read', { cwd }, CONFIG_READ_TIMEOUT_MS);
    } catch {
        return undefined;
    }
    if (!isRecord(result) || !isRecord(result.config)) return undefined;
    const configured = stringField(result.config.developer_instructions);
    return configured ? `${configured}\n\n${instructions}` : instructions;
}

/**
 * Resumes `threadId` and reads its history, or starts a new thread when there is none.
 */
export async function openCodexThread(
    connection: JsonRpcConnection,
    {
        cwd,
        settings,
        instructions,
        threadId,
    }: { cwd: string; settings: CodexThreadSettings; instructions?: string; threadId?: string },
): Promise<CodexThreadOpening> {
    const developer = await developerInstructions(connection, cwd, instructions);
    const threadParameters = {
        cwd,
        approvalPolicy: settings.approvalPolicy,
        approvalsReviewer: settings.approvalsReviewer,
        sandbox: settings.sandbox,
        config: { 'tools.update_plan.enabled': true },
        ...(developer && { developerInstructions: developer }),
    };
    if (threadId) {
        let result: unknown;
        try {
            /**
             * `model` is omitted on purpose: naming one would override the thread's own saved model and effort. The
             * history is read separately, since a paginated thread resumed with its turns gets a `deprecationNotice`.
             */
            result = await connection.request(
                'thread/resume',
                { ...threadParameters, threadId, excludeTurns: true },
                THREAD_OPEN_TIMEOUT_MS,
            );
        } catch (error) {
            await connection.close();
            if (isThreadWriterConflict(error))
                throw new AgentChatStartError(
                    'conversation_in_use',
                    'Another Codex client is using this conversation',
                );
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
        let turns: unknown[];
        try {
            turns = await readCodexThreadTurns(
                (method, parameters, timeoutMs) =>
                    connection.request(method, parameters, timeoutMs),
                thread,
                THREAD_OPEN_TIMEOUT_MS,
            );
        } catch {
            await connection.close();
            throw new AgentChatStartError(
                'resume_failed',
                'Codex could not read this conversation',
            );
        }
        return { outcome: 'resumed', thread: { ...thread, turns }, ...reportedModel(result) };
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
    return { outcome: 'started', threadId: startedId, ...reportedModel(result) };
}
