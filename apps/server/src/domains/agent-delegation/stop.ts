import type { AgentDelegationReceipt } from '@caxri/protocol';
import { isDelegationActive } from '@caxri/protocol';

import type { StoredAgentDelegation } from '../db';
import type { AgentDelegationServiceOptions } from './service-options';

/**
 * What stopping a task borrows from the delegation service.
 */
export interface DelegationStopHost {
    options: Pick<AgentDelegationServiceOptions, 'database' | 'write'>;
    save(record: StoredAgentDelegation): StoredAgentDelegation;
}

/**
 * Corrects a Stop that reported `caller_stopped` before the Terminal Host refused its Esc. The task is interrupted
 * either way; what changes is whether the Agent was actually told to stop.
 */
function settleStop(host: DelegationStopHost, id: string, wasDelivered: boolean): void {
    if (wasDelivered) return;
    const record = host.options.database.agentDelegations.get(id);
    if (record?.receipt.status !== 'interrupted' || record.receipt.failure !== 'caller_stopped')
        return;
    host.save({
        ...record,
        receipt: { ...record.receipt, failure: 'target_changed' },
    });
}

/**
 * Stops an owned task: sends the Agent an Esc on its own launch and marks the task interrupted. A task that is not
 * running, or is already collecting its answer, is returned as it is.
 */
export function stopDelegation(
    host: DelegationStopHost,
    record: StoredAgentDelegation,
): AgentDelegationReceipt {
    if (!isDelegationActive(record.receipt) || record.receipt.status === 'collecting')
        return record.receipt;
    const { terminalId, delegationId } = record.receipt;
    const accepted =
        !terminalId ||
        !record.launchId ||
        host.options.write?.(terminalId, record.launchId, '\u{1B}', (wasDelivered) =>
            settleStop(host, delegationId, wasDelivered),
        );
    return host.save({
        ...record,
        receipt: {
            ...record.receipt,
            status: 'interrupted',
            failure: accepted ? 'caller_stopped' : 'target_changed',
        },
    }).receipt;
}
