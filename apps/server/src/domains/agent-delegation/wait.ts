import { setTimeout as delay } from 'node:timers/promises';

import type { AgentDelegationAnswer, AgentDelegationReceipt } from '@caxri/protocol';
import { CaxriError, isDelegationActive } from '@caxri/protocol';

interface DelegationRead {
    receipt: AgentDelegationReceipt;
    answer?: AgentDelegationAnswer;
}

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
 * Long-polls the given tasks in argument order and returns the first that settled or blocked, or the first task's
 * current state on timeout. Reads run one at a time, so a wait over many tasks never fans out concurrent transcript
 * reads.
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
                return { ...result, outcome: 'settled' as const };
            if (result.receipt.status === 'blocked')
                return { ...result, outcome: 'blocked' as const };
            first ??= result;
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0) return { ...first!, outcome: 'timeout' as const };
        // eslint-disable-next-line no-await-in-loop -- bounded long polling must never issue concurrent reads
        await delay(Math.min(200, remaining), undefined, { signal });
    }
    throw new CaxriError('UNAVAILABLE', 'Delegation service is closed');
}
