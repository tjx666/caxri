import { setTimeout as delay } from 'node:timers/promises';

import type { AgentDelegationAnswer, AgentDelegationReceipt } from '@caxri/protocol';
import { CaxriError, isDelegationActive } from '@caxri/protocol';

interface DelegationRead {
    receipt: AgentDelegationReceipt;
    answer?: AgentDelegationAnswer;
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
    while (!isClosed()) {
        let first: DelegationRead | undefined;
        for (const id of watched) {
            // eslint-disable-next-line no-await-in-loop -- each read observes the previous wait's newer durable state
            const result = await read(id);
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
