import type { AgentDelegationReceipt } from '@caxri/protocol';
import { isDelegationActive } from '@caxri/protocol';

import type { StoredAgentDelegation } from '../db';
import type { DelegationAuthority } from './admission';
import { collectionIntervalMs } from './result';

/**
 * What {@link CollectionTimers} borrows from the service.
 */
export interface CollectionTimersHost {
    isClosed(): boolean;
    result(
        id: string,
        authority: DelegationAuthority,
    ): Promise<{ receipt: AgentDelegationReceipt }>;
    fail(id: string, failure: AgentDelegationReceipt['failure']): void;
}

/**
 * Re-reads an active task's result on a provider-specific interval until it settles, one timer per task.
 */
export class CollectionTimers {
    private readonly timers = new Map<string, NodeJS.Timeout>();

    constructor(private readonly host: CollectionTimersHost) {}

    schedule(record: StoredAgentDelegation): void {
        const id = record.receipt.delegationId;
        if (this.host.isClosed() || this.timers.has(id)) return;
        const timer = setTimeout(async () => {
            this.timers.delete(id);
            try {
                const result = await this.host.result(id, {
                    principal: record.principal,
                    callerTerminalId: record.receipt.callerTerminalId,
                });
                if (isDelegationActive(result.receipt)) this.schedule(record);
            } catch {
                // Session deletion or shutdown ends ownership; never copy provider content into diagnostics.
                if (!this.host.isClosed()) this.host.fail(id, 'result_missing');
            }
        }, collectionIntervalMs(record.receipt.provider));
        timer.unref();
        this.timers.set(id, timer);
    }

    close(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
    }
}
