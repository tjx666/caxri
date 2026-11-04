import { setTimeout as delay } from 'node:timers/promises';

import type {
    AgentDelegationAnswer,
    AgentDelegationReceipt,
    DelegationApproval,
} from '@caxri/protocol';
import { CaxriError, isDelegationActive } from '@caxri/protocol';

interface DelegationRead {
    receipt: AgentDelegationReceipt;
    answer?: AgentDelegationAnswer;
    /**
     * The task's open question, when the caller wants to hear about it. Its ID only, never its text. A task that
     * settled has none: settling closes its question before the receipt is readable as settled.
     */
    questionId?: string;
    /**
     * The task's pending permission request, with its content: only the Agent that delegated the task reads it.
     */
    approval?: DelegationApproval;
}

/**
 * Whether the delegating Agent may decide the approval now: covered, and the user has not been shown it.
 */
const isDecidable = (approval: DelegationApproval | undefined) =>
    approval?.covered === true && !approval.escalated;

/**
 * The read without its approval. `wait` reports one only as the `approval` outcome, or on a `blocked` task whose
 * request is the user's; anywhere else the delegating Agent would see a decidable request it was not told to decide.
 */
function withoutApproval(read: DelegationRead): DelegationRead {
    const { approval, ...rest } = read;
    return approval === undefined ? read : rest;
}

/**
 * Most `wait` long polls open at once.
 */
const MAX_WAITERS = 64;

/**
 * How long one read may run past the wait's own deadline. Public delegation waits carry no client transport timer,
 * because it would start before the Server's timer and always turn the timeout result into a transport error, so a
 * transcript read that never settles would otherwise hold the waiter slot and the caller's request open indefinitely.
 */
const READ_GRACE_MS = 5000;

/**
 * Settles with the read, or fails once the whole wait's hard deadline passes or the caller goes away.
 */
async function boundedRead(
    read: Promise<DelegationRead>,
    hardDeadline: number,
    signal?: AbortSignal,
) {
    const settled = new AbortController();
    const expiry = (async () => {
        await delay(Math.max(0, hardDeadline - performance.now()), undefined, {
            signal: signal ? AbortSignal.any([signal, settled.signal]) : settled.signal,
        });
        throw new CaxriError('TIMEOUT', 'Delegation read did not finish before the wait deadline');
    })();
    try {
        return await Promise.race([read, expiry]);
    } finally {
        settled.abort();
    }
}

/**
 * Long-polls the given tasks in argument order and returns the first that settled, has an open question, has a request
 * the caller may decide, or blocked (in that order for each task), or the first task's current state on timeout. Reads
 * run one at a time, so a wait over many tasks never fans out concurrent transcript reads.
 */
export async function pollDelegations(
    ids: readonly [string, ...string[]],
    read: (id: string) => Promise<DelegationRead>,
    isClosed: () => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
) {
    const watched = [...new Set(ids)];
    const deadline = performance.now() + timeoutMs;
    // One fixed bound for the whole wait: reads that run one after another must not each earn a fresh grace period.
    const hardDeadline = deadline + READ_GRACE_MS;
    while (!isClosed()) {
        let first: DelegationRead | undefined;
        for (const id of watched) {
            // eslint-disable-next-line no-await-in-loop -- each read observes the previous wait's newer durable state
            const result = await boundedRead(read(id), hardDeadline, signal);
            if (!isDelegationActive(result.receipt))
                return { ...withoutApproval(result), outcome: 'settled' as const };
            if (result.questionId)
                return {
                    ...withoutApproval(result),
                    outcome: 'question' as const,
                    questionId: result.questionId,
                };
            if (isDecidable(result.approval)) return { ...result, outcome: 'approval' as const };
            if (result.receipt.status === 'blocked')
                return { ...result, outcome: 'blocked' as const };
            first ??= result;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) return { ...withoutApproval(first!), outcome: 'timeout' as const };
        // eslint-disable-next-line no-await-in-loop -- bounded long polling must never issue concurrent reads
        await delay(Math.min(200, remaining), undefined, { signal });
    }
    throw new CaxriError('UNAVAILABLE', 'Delegation service is closed');
}

/**
 * Counts the open long polls so one caller cannot hold them all, and runs {@link pollDelegations} under that bound.
 */
export class DelegationWaiters {
    private count = 0;

    async poll(...arguments_: Parameters<typeof pollDelegations>) {
        if (this.count >= MAX_WAITERS)
            throw new CaxriError('CAPACITY', 'Too many delegation waiters');
        this.count++;
        try {
            return await pollDelegations(...arguments_);
        } finally {
            this.count--;
        }
    }
}
