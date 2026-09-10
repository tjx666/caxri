import type { AgentDelegationReceipt } from '@caxri/protocol';

import type { AgentLifecycleSignal } from '../agents';
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
        if (record.turnId && signal.agentTurnId === record.turnId) return;
        if (record.turnId || signal.agentPromptDigest !== record.promptDigest)
            return patch('answer_unavailable', 'correlation_missing');
        if (!signal.agentTurnId) return patch('answer_unavailable', 'correlation_missing');
        return { ...patch('running'), turnId: signal.agentTurnId };
    }
    if (!record.turnId || signal.agentTurnId !== record.turnId) return;
    if (signal.phase === 'attentionRequested') return patch('blocked', 'permission_required');
    if (signal.phase !== 'turnFinished') return;
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
