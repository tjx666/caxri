import { setTimeout as delay } from 'node:timers/promises';

import type { DelegationQuestionWaitResult } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { StoredDelegationQuestion } from '../../db';

/**
 * Most `askWait` long polls open at once.
 */
export const MAX_QUESTION_WAITERS = 64;

/**
 * How a closed question reads to the Agent that asked it.
 */
function closedQuestionResult(
    question: StoredDelegationQuestion,
): DelegationQuestionWaitResult | undefined {
    if (question.state === 'answered')
        return {
            outcome: 'answered',
            ...(question.answerText !== undefined && { answer: question.answerText }),
            ...(question.answeredBy && { answeredBy: question.answeredBy }),
        };
    if (question.state === 'cancelled')
        return {
            outcome: 'cancelled',
            ...(question.cancelReason && { cancelReason: question.cancelReason }),
        };
    return undefined;
}

/**
 * Long-polls one question until it closes or the wait ends. `read` runs on every pass, before any result is returned,
 * and throws when the asking Agent no longer owns the question (its launch or Endpoint generation changed), so a
 * restarted Agent in the same Terminal never reads an old answer. A `timeout` leaves the question open.
 */
export async function pollQuestion(
    read: () => StoredDelegationQuestion,
    isClosed: () => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<DelegationQuestionWaitResult> {
    const deadline = performance.now() + timeoutMs;
    while (!isClosed()) {
        const closed = closedQuestionResult(read());
        if (closed) return closed;
        const remaining = deadline - performance.now();
        if (remaining <= 0) return { outcome: 'timeout' };
        // eslint-disable-next-line no-await-in-loop -- bounded long polling re-reads the durable state each pass
        await delay(Math.min(200, remaining), undefined, { signal });
    }
    throw new CaxriError('UNAVAILABLE', 'Delegation service is closed');
}
