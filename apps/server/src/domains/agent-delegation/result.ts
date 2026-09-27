import { Buffer } from 'node:buffer';

import type { AgentProvider } from '@caxri/protocol';
import { isDelegationActive } from '@caxri/protocol';

import type { DelegationCompletion } from '../agents';
/**
 * Provider launch, identity, and finality stay behind the agents domain's public API.
 */
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { delegationAdapter } from '../agents';
import type { StoredAgentDelegation } from '../db';

/**
 * How long one task waits between transcript reads. A native-completion provider writes its answer once at the end of
 * the turn, so polling it faster only repeats reads that cannot succeed yet.
 */
export function collectionIntervalMs(provider: AgentProvider): number {
    return delegationAdapter(provider).completion === 'native-completion' ? 2_000 : 200;
}

export function shouldCollectDelegation(record: StoredAgentDelegation): boolean {
    return (
        record.receipt.status === 'collecting' ||
        Boolean(
            record.turnId &&
            isDelegationActive(record.receipt) &&
            delegationAdapter(record.receipt.provider).completion === 'native-completion',
        )
    );
}

/**
 * Applies only proven provider completion; an active native turn has no elapsed-time missing-answer deadline.
 */
export function applyDelegationCompletion(
    record: StoredAgentDelegation,
    completion: DelegationCompletion | undefined,
    now: number,
    isNativeFinished = false,
): StoredAgentDelegation | undefined {
    if (completion?.kind === 'failed') {
        const status = ['payload_overflow', 'result_missing', 'correlation_missing'].includes(
            completion.failure,
        )
            ? 'answer_unavailable'
            : 'failed';
        return {
            ...record,
            receipt: {
                ...record.receipt,
                status,
                failure: completion.failure,
                correlationFailure:
                    completion.failure === 'correlation_missing'
                        ? 'completion_ambiguous'
                        : undefined,
                usage: completion.usage,
            },
        };
    }
    if (completion?.kind === 'answer') {
        const byteLength = Buffer.byteLength(completion.text);
        if (byteLength > 65_536)
            return {
                ...record,
                receipt: {
                    ...record.receipt,
                    status: 'answer_unavailable',
                    failure: 'payload_overflow',
                    usage: completion.usage,
                },
            };
        return {
            ...record,
            receipt: {
                ...record.receipt,
                status: 'completed',
                failure: undefined,
                usage: completion.usage,
            },
            answer: {
                text: completion.text,
                messageId: completion.messageId,
                byteLength,
                source: 'transcript',
                truncated: false,
            },
        };
    }
    // A persisted terminal state proves finality even when the bounded transcript locator cannot find the result.
    if (isNativeFinished && record.receipt.status !== 'collecting')
        return { ...record, receipt: { ...record.receipt, status: 'collecting', updatedAt: now } };
    if (record.receipt.status === 'collecting' && now - record.receipt.updatedAt > 15_000)
        return {
            ...record,
            receipt: { ...record.receipt, status: 'answer_unavailable', failure: 'result_missing' },
        };
    return;
}
