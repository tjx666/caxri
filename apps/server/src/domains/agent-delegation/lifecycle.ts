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
 * A task whose Agent has not started its turn yet: still inside the startup deadline, or past it with the process alive
 * and presumably waiting on a first-run prompt. Nothing has entered the Agent's conversation in either state.
 */
export function isAwaitingStartup(record: StoredAgentDelegation): boolean {
    const { status, failure } = record.receipt;
    return (
        !record.turnId &&
        (status === 'awaiting_ready' || (status === 'blocked' && failure === 'startup_waiting'))
    );
}

/**
 * Only coordinator-applied, main-agent signals may close a turn. A deferred parent Stop remains in the coordinator
 * until all child work is settled. Grok Stop evidence uses the separate authenticated-hook source, so native continued
 * drafts are counted without treating them as completed lifecycle events or counting deferred replays twice.
 */
export function applyDelegationLifecycle(
    record: StoredAgentDelegation,
    signal: AgentLifecycleSignal,
    source: 'lifecycle' | 'evidence' = 'lifecycle',
): StoredAgentDelegation | undefined {
    const isGrokStop = signal.provider === 'grok' && signal.phase === 'turnFinished';
    if (isGrokStop !== (source === 'evidence')) return;
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
        (['launching', 'submitting'].includes(record.receipt.status) || isAwaitingStartup(record))
    ) {
        /**
         * The native session starting means any startup prompt was answered, so a task past its deadline goes back to
         * waiting for its turn.
         */
        record = {
            ...record,
            providerSessionId: signal.agentSessionId,
            ...(isAwaitingStartup(record) && {
                receipt: { ...record.receipt, status: 'awaiting_ready', failure: undefined },
            }),
        };
        if (signal.phase !== 'turnStarted') return record;
    }
    const patch = (
        status: AgentDelegationReceipt['status'],
        failure?: AgentDelegationReceipt['failure'],
        correlationFailure?: AgentDelegationReceipt['correlationFailure'],
    ) => ({
        ...record,
        receipt: { ...record.receipt, status, failure, correlationFailure },
    });
    if (signal.agentSessionId && signal.agentSessionId !== record.providerSessionId)
        return patch('interrupted', 'session_changed');
    if (signal.phase === 'turnStarted') {
        if (isNativeCompletion && !record.providerSessionId)
            return patch('answer_unavailable', 'correlation_missing', 'native_session_missing');
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
                responseStopCount: undefined,
                responseDigest: undefined,
                responseByteLength: undefined,
                responseOverflow: undefined,
            };
        }
        if (record.turnId)
            return patch('answer_unavailable', 'correlation_missing', 'turn_changed');
        if (signal.agentPromptDigest !== record.promptDigest)
            return patch(
                'answer_unavailable',
                'correlation_missing',
                signal.agentPromptDigest ? 'prompt_digest_mismatch' : 'prompt_digest_missing',
            );
        if (!signal.agentTurnId)
            return patch('answer_unavailable', 'correlation_missing', 'turn_missing');
        return { ...patch('running'), turnId: signal.agentTurnId };
    }
    if (!record.turnId || signal.agentTurnId !== record.turnId) return;
    if (signal.phase === 'attentionRequested') return patch('blocked', 'permission_required');
    if (signal.phase !== 'turnFinished' && signal.phase !== 'turnFailed') return;
    if (signal.agentFailure || signal.phase === 'turnFailed') {
        const failures = {
            rate_limit: 'rate_limited',
            billing_error: 'quota_exhausted',
            authentication_failed: 'authentication_failed',
            max_output_tokens: 'output_limit',
            provider_failed: 'provider_failed',
        } as const;
        return patch('failed', failures[signal.agentFailure ?? 'provider_failed']);
    }
    // Codex may continue this same turn after another Stop hook blocks; keep it cancelable until native completion.
    if (isNativeCompletion)
        return record.receipt.provider === 'grok'
            ? {
                  ...record,
                  // Every authenticated Stop has a native batch, even when no answer text exists.
                  // Clear earlier proof so an empty final Stop cannot authenticate a stale draft.
                  responseDigest: signal.agentResponseDigest,
                  responseByteLength: signal.agentResponseByteLength,
                  responseStopCount: (record.responseStopCount ?? 0) + 1,
                  responseOverflow: signal.agentContentOverflow,
              }
            : undefined;
    if (signal.agentContentOverflow) return patch('answer_unavailable', 'payload_overflow');
    if (!signal.agentResponseDigest)
        return patch('answer_unavailable', 'correlation_missing', 'answer_digest_missing');
    return { ...patch('collecting'), responseDigest: signal.agentResponseDigest };
}
