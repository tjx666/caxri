import type { AgentDelegationReceipt } from '@caxri/protocol';

import type { AgentLifecycleSignal } from '../agents';
/**
 * Provider launch, identity, and finality stay behind the agents domain's public API.
 */
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { delegationAdapter } from '../agents';
import type { StoredAgentDelegation } from '../db';

export function isDelegationActive(receipt: AgentDelegationReceipt): boolean {
    return [
        'requested',
        'launching',
        'awaiting_ready',
        'submitting',
        'running',
        'collecting',
        'blocked',
    ].includes(receipt.status);
}

/**
 * Only coordinator-applied, main-agent signals may close a turn. A deferred parent Stop remains in the coordinator
 * until all child work is settled.
 */
export function applyDelegationLifecycle(
    record: StoredAgentDelegation,
    signal: AgentLifecycleSignal,
): StoredAgentDelegation | undefined {
    if (
        !isDelegationActive(record.receipt) ||
        signal.agentId ||
        signal.provider !== record.receipt.provider ||
        signal.terminalId !== record.receipt.terminalId ||
        signal.launchId !== record.launchId
    )
        return;
    const isNativeCompletion =
        delegationAdapter(record.receipt.provider).completion === 'native-completion';
    if (
        isNativeCompletion &&
        !record.providerSessionId &&
        signal.agentSessionId &&
        ['launching', 'awaiting_ready', 'submitting'].includes(record.receipt.status)
    ) {
        record = { ...record, providerSessionId: signal.agentSessionId };
        if (signal.phase !== 'turnStarted') return record;
    }
    const patch = (
        status: AgentDelegationReceipt['status'],
        failure?: AgentDelegationReceipt['failure'],
    ) => ({
        ...record,
        receipt: { ...record.receipt, status, failure },
    });
    if (signal.agentSessionId && signal.agentSessionId !== record.providerSessionId)
        return patch('interrupted', 'session_changed');
    if (signal.phase === 'turnStarted') {
        if (isNativeCompletion && !record.providerSessionId)
            return patch('answer_unavailable', 'correlation_missing');
        if (record.turnId && signal.agentTurnId === record.turnId) return;
        if (
            record.turnId &&
            signal.agentContinuedTurnId === record.turnId &&
            signal.agentTurnId &&
            signal.agentPromptDigest
        ) {
            const digests = [...(record.continuationPromptDigests ?? []), signal.agentPromptDigest];
            if (digests.length > 64) return patch('answer_unavailable', 'payload_overflow');
            return {
                ...patch('running'),
                turnId: signal.agentTurnId,
                continuationPromptDigests: digests,
            };
        }
        if (record.turnId || signal.agentPromptDigest !== record.promptDigest)
            return patch('answer_unavailable', 'correlation_missing');
        if (!signal.agentTurnId) return patch('answer_unavailable', 'correlation_missing');
        return { ...patch('running'), turnId: signal.agentTurnId };
    }
    if (!record.turnId || signal.agentTurnId !== record.turnId) return;
    if (signal.phase === 'attentionRequested') return patch('blocked', 'permission_required');
    if (signal.phase !== 'turnFinished') return;
    // Codex may continue this same turn after another Stop hook blocks; keep it cancelable until native completion.
    if (isNativeCompletion) return;
    if (signal.agentFailure) {
        const failures = {
            rate_limit: 'rate_limited',
            billing_error: 'quota_exhausted',
            authentication_failed: 'authentication_failed',
            max_output_tokens: 'output_limit',
            provider_failed: 'provider_failed',
        } as const;
        return patch('failed', failures[signal.agentFailure]);
    }
    if (signal.agentContentOverflow) return patch('answer_unavailable', 'payload_overflow');
    if (!signal.agentResponseDigest) return patch('answer_unavailable', 'correlation_missing');
    return { ...patch('collecting'), responseDigest: signal.agentResponseDigest };
}
