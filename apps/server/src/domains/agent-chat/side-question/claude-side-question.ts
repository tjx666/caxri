import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { CaxriError } from '@caxri/protocol';

import type { ChatSideExchange } from '../chat-provider';
import { withTimeout } from '../claude-prompt-queue';
import { EmptySideAnswerError } from './side-answer-error';

/**
 * A side question runs one model request without tools, so it answers in seconds; a process that is silent for longer
 * is stuck, and the Client should not wait on it.
 */
const CLAUDE_SIDE_QUESTION_TIMEOUT_MS = 60_000;

interface SideQuestionQuery {
    askSideQuestion(
        question: string,
        options?: { history?: readonly ChatSideExchange[]; signal?: AbortSignal },
    ): Promise<{ response: string } | null>;
}

/**
 * `Query.askSideQuestion` is the control request behind Claude Code's `/btw`. The SDK ships it at runtime (0.3.296) but
 * not in `sdk.d.ts`, so it is reached through a structural cast, and an SDK without it fails the question instead of
 * the process.
 */
export async function askClaudeSideQuestion(
    query: Query,
    question: string,
    history: readonly ChatSideExchange[],
    timeoutMs = CLAUDE_SIDE_QUESTION_TIMEOUT_MS,
): Promise<string> {
    const ask = (query as unknown as Partial<SideQuestionQuery>).askSideQuestion;
    if (typeof ask !== 'function')
        throw new CaxriError(
            'UNAVAILABLE',
            'This Claude Code version cannot answer side questions',
        );
    const controller = new AbortController();
    let answer: { response: string } | null;
    try {
        answer = await withTimeout(
            ask.call(query, question, { history, signal: controller.signal }),
            timeoutMs,
        );
    } catch (error) {
        // Releases the pending control request when the timeout won the race.
        controller.abort();
        throw error;
    }
    if (!answer?.response.trim()) throw new EmptySideAnswerError('Claude');
    return answer.response;
}
