import type { DelegationRetryScheduleOutcome } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { StoredAgentDelegation } from '../../db';
import type { DelegationRetryHost } from './service';

/**
 * Reads and writes the claim a retry holds on its failed task (`retriedAs`, the mode, and a pending schedule time).
 * Every method reads the stored record afresh: other saves may have moved on since the caller looked.
 */
export class RetryClaims {
    constructor(private readonly host: Pick<DelegationRetryHost, 'options' | 'save'>) {}

    private get database() {
        return this.host.options.database;
    }

    load(id: string): StoredAgentDelegation {
        const record = this.database.agentDelegations.get(id);
        if (!record) throw new CaxriError('NOT_FOUND', 'Delegation is unavailable');
        return record;
    }

    /**
     * How many retries precede `failed` in its chain, capped for a corrupt cycle.
     */
    chainDepth(failed: StoredAgentDelegation): number {
        let depth = 0;
        let current: StoredAgentDelegation | undefined = failed;
        while (current?.receipt.retryOf && depth < 32) {
            depth++;
            current = this.database.agentDelegations.get(current.receipt.retryOf);
        }
        return depth;
    }

    /**
     * Clears a claim whose task was never stored, and any pending schedule with it. `outcome` is the scheduled retry's
     * refusal, written in the same save so the claim never reads released without its reason.
     */
    release(
        failedId: string,
        isAnnounced = true,
        outcome?: DelegationRetryScheduleOutcome,
    ): StoredAgentDelegation {
        const current = this.load(failedId);
        return this.host.save(
            {
                ...current,
                retryMode: undefined,
                retryProvider: undefined,
                receipt: {
                    ...current.receipt,
                    retriedAs: undefined,
                    retryScheduledFor: undefined,
                    retryScheduleOutcome: outcome,
                },
            },
            isAnnounced,
        );
    }

    /**
     * {@link release} for a claim that may be gone or may have produced its task meanwhile: neither is touched.
     */
    releaseUnstored(failedId: string, outcome?: DelegationRetryScheduleOutcome): void {
        const current = this.database.agentDelegations.get(failedId);
        if (
            !current?.receipt.retriedAs ||
            this.database.agentDelegations.get(current.receipt.retriedAs)
        )
            return;
        this.release(failedId, true, outcome);
    }

    /**
     * Drops the pending time of a schedule whose task is stored: from here the claim reads as an ordinary retry.
     */
    settlePending(failedId: string, isAnnounced = true): void {
        const current = this.database.agentDelegations.get(failedId);
        if (current?.receipt.retryScheduledFor === undefined) return;
        this.host.save(
            { ...current, receipt: { ...current.receipt, retryScheduledFor: undefined } },
            isAnnounced,
        );
    }
}
