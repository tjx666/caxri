import type { AgentChatSnapshot } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import { isRecord, stringField } from './chat-items';
import type { ChatSideExchange } from './chat-provider';
import type { JsonRpcConnection } from './json-rpc-connection';
import { JsonRpcRequestError } from './json-rpc-connection';
import { EmptySideAnswerError } from './side-answer-error';

type Json = Record<string, unknown>;

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A side question is one model turn without tools; a fork that has not finished by then is stuck.
 */
const CODEX_SIDE_QUESTION_TIMEOUT_MS = 120_000;

/**
 * The fork inherits the whole conversation, so the instructions only frame the turn as an aside.
 */
const SIDE_QUESTION_INSTRUCTIONS =
    'The user is asking a quick side question about this conversation. Answer it directly and concisely from the ' +
    'conversation so far. Do not run commands, edit files, or call tools. This exchange is not part of the main ' +
    'conversation and the main task is not affected by it.';

/**
 * The side thread so far plus the new question, as the one user message the fork's turn answers. The fork is ephemeral
 * and starts from the main conversation each time, so earlier side exchanges travel in the prompt.
 */
function codexSideQuestionPrompt(question: string, history: readonly ChatSideExchange[]): string {
    if (history.length === 0) return question;
    const earlier = history
        .map((exchange) => `Q: ${exchange.question}\nA: ${exchange.response}`)
        .join('\n\n');
    return `Earlier in this side thread:\n\n${earlier}\n\nNew side question: ${question}`;
}

interface SideRun {
    answer: string | undefined;
    deltas: Map<string, string>;
    settle: (outcome: { error?: CaxriError }) => void;
}

/**
 * Answers side questions on ephemeral read-only forks of the Chat's thread, in the Chat's own app-server process. A
 * fork is a thread of its own, so its turn never touches the main thread: it runs while the main turn runs and adds
 * nothing to the main conversation. The session routes the fork's notifications here before its subagent routing, which
 * would adopt an unknown thread as a task.
 */
export class CodexSideQuestions {
    private readonly runs = new Map<string, SideRun>();

    private async fork(
        connection: JsonRpcConnection,
        threadId: string,
        lastTurnId: string | undefined,
    ): Promise<string> {
        let forked: unknown;
        try {
            forked = await connection.request(
                'thread/fork',
                {
                    threadId,
                    ...(lastTurnId && { lastTurnId }),
                    ephemeral: true,
                    excludeTurns: true,
                    sandbox: 'read-only',
                    approvalPolicy: 'never',
                    developerInstructions: SIDE_QUESTION_INSTRUCTIONS,
                },
                REQUEST_TIMEOUT_MS,
            );
        } catch (error) {
            if (!(error instanceof JsonRpcRequestError)) throw error;
            throw new CaxriError('UNAVAILABLE', 'Codex could not open a side question');
        }
        const id =
            isRecord(forked) && isRecord(forked.thread) ? stringField(forked.thread.id) : undefined;
        if (!id) throw new CaxriError('UNAVAILABLE', 'Codex did not report the side thread');
        return id;
    }

    /**
     * Takes a notification of a side fork; false when `threadId` is not one.
     */
    onNotification(threadId: string | undefined, method: string, parameters: Json): boolean {
        const run = threadId ? this.runs.get(threadId) : undefined;
        if (!run) return false;
        switch (method) {
            case 'item/completed': {
                const item = parameters.item;
                if (isRecord(item) && item.type === 'agentMessage') {
                    const text = stringField(item.text);
                    if (text !== undefined) run.answer = text;
                }
                break;
            }
            case 'item/agentMessage/delta': {
                const itemId = stringField(parameters.itemId);
                if (itemId && typeof parameters.delta === 'string')
                    run.deltas.set(itemId, (run.deltas.get(itemId) ?? '') + parameters.delta);
                break;
            }
            case 'turn/completed': {
                const turn = isRecord(parameters.turn) ? parameters.turn : undefined;
                run.settle(
                    turn?.status === 'completed'
                        ? {}
                        : { error: new CaxriError('UNAVAILABLE', 'Codex could not answer') },
                );
                break;
            }
            default: {
                // Reasoning, token usage, and warnings of the fork are not shown.
            }
        }
        return true;
    }

    async ask(
        connection: JsonRpcConnection,
        threadId: string,
        { activeTurnId, turns }: Pick<AgentChatSnapshot, 'activeTurnId' | 'turns'>,
        question: string,
        history: readonly ChatSideExchange[],
        timeoutMs = CODEX_SIDE_QUESTION_TIMEOUT_MS,
    ): Promise<string> {
        // `thread/fork` refuses a turn in progress, so a running Chat forks through its last finished turn.
        const lastTurnId = activeTurnId
            ? turns.findLast((turn) => turn.status !== 'running')?.id
            : undefined;
        const forkId = await this.fork(connection, threadId, lastTurnId);
        let timer: NodeJS.Timeout | undefined;
        try {
            const run: SideRun = {
                answer: undefined,
                deltas: new Map(),
                settle: () => {},
            };
            const settled = new Promise<{ error?: CaxriError }>((resolve) => {
                run.settle = resolve;
                timer = setTimeout(
                    () => resolve({ error: new CaxriError('TIMEOUT', 'Codex did not respond') }),
                    timeoutMs,
                );
                timer.unref();
            });
            this.runs.set(forkId, run);
            await connection.request(
                'turn/start',
                {
                    threadId: forkId,
                    input: [
                        {
                            type: 'text',
                            text: codexSideQuestionPrompt(question, history),
                            text_elements: [],
                        },
                    ],
                    summary: 'none',
                },
                REQUEST_TIMEOUT_MS,
            );
            const { error } = await settled;
            if (error) throw error;
            const answer = (run.answer ?? run.deltas.values().toArray().join('\n\n')).trim();
            if (!answer) throw new EmptySideAnswerError('Codex');
            return answer;
        } finally {
            clearTimeout(timer);
            this.runs.delete(forkId);
            // The fork is ephemeral; releasing it stops its turn if one is still running and frees the thread.
            try {
                await connection.request(
                    'thread/unsubscribe',
                    { threadId: forkId },
                    REQUEST_TIMEOUT_MS,
                );
            } catch {
                // The fork is gone with the connection or already released; nothing is left to clean up.
            }
        }
    }
}
