import { join } from 'node:path';

import { CaxriDatabase } from '../../../apps/server/src/domains/db';

interface Input {
    /**
     * The profile directory that holds `caxri.db`. The app keeps running on it.
     */
    userData: string;
    /**
     * The delegated child whose task is marked failed.
     */
    sessionId: string;
    /**
     * The failure to record. Defaults to `provider_failed`; a usage-limit failure (`quota_exhausted`) is what offers
     * "Retry after" and "Retry with".
     */
    failure?: 'provider_failed' | 'quota_exhausted' | 'rate_limited';
    /**
     * When the failing provider's usage limit resets (epoch ms), the trusted time a scheduled retry waits for. Omit it
     * for a failure with no known reset time.
     */
    failureResetsAt?: number;
}

/**
 * Rewrites the task of a delegated child as failed with a retryable provider failure and returns its ID. A fake child
 * cannot fail the way a real provider does, so the failure is injected on the record the Server created for the real
 * delegation. The Server reads delegation records from the database on every request, so the running app sees it.
 */
export function run(input: Input): string {
    const database = new CaxriDatabase(join(input.userData, 'caxri.db'));
    try {
        const record = database.agentDelegations
            .all()
            .find((entry) => entry.receipt.sessionId === input.sessionId);
        if (!record) throw new Error('No delegation record for the child Session');
        const now = Date.now();
        database.agentDelegations.save({
            ...record,
            answer: undefined,
            receipt: {
                ...record.receipt,
                status: 'failed',
                failure: input.failure ?? 'provider_failed',
                ...(input.failureResetsAt !== undefined && {
                    failureResetsAt: input.failureResetsAt,
                }),
                settledAt: now,
                updatedAt: now,
                revision: record.receipt.revision + 1,
            },
        });
        return record.receipt.delegationId;
    } finally {
        database.close();
    }
}
