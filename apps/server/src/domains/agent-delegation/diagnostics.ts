import type {
    AgentDelegationCreate,
    AgentDelegationReceipt,
    DelegationResultSource,
    DelegationRetryMode,
    DelegationRetryUnavailableReason,
    SessionRelation,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

/**
 * Records one receipt transition. `isRecovery` marks a transition Server startup applied to a task the previous Server
 * left active, which is never announced to Caxri Bot.
 */
export function logDelegationTransition(
    logger: StructuredLogger | undefined,
    receipt: AgentDelegationReceipt,
    previous: AgentDelegationReceipt | undefined,
    isRecovery: boolean,
): void {
    logger?.write('info', logEventCatalog.agentDelegation.transitioned, {
        fields: {
            delegationId: receipt.delegationId,
            sessionId: receipt.sessionId,
            terminalId: receipt.terminalId ?? null,
            provider: receipt.provider,
            previousStatus: previous?.status ?? null,
            status: receipt.status,
            failure: receipt.failure ?? null,
            isRecovery,
            ageMs: receipt.updatedAt - receipt.createdAt,
            ...(isUsageLimitFailure(receipt.failure) && {
                hasFailureResetsAt: receipt.failureResetsAt !== undefined,
            }),
        },
    });
}

function isUsageLimitFailure(failure: AgentDelegationReceipt['failure']): boolean {
    return failure === 'quota_exhausted' || failure === 'rate_limited';
}

/**
 * Records that a completed task changed its Session's stored result: a summary written (with where it came from) or the
 * earlier one removed because this answer had none. Content-free; `durationMs` runs from the task's creation.
 */
export function logDelegationResult(
    logger: StructuredLogger | undefined,
    receipt: AgentDelegationReceipt,
    result: { outcome: 'no_summary' } | { outcome: 'stored'; source: DelegationResultSource },
): void {
    logger?.write('info', logEventCatalog.agentDelegation.resultRecorded, {
        fields: {
            delegationId: receipt.delegationId,
            sessionId: receipt.sessionId,
            outcome: result.outcome,
            summarySource: result.outcome === 'stored' ? result.source : null,
            durationMs: (receipt.settledAt ?? receipt.updatedAt) - receipt.createdAt,
        },
    });
}

/**
 * Records an admitted task and how it continues its chain, before its Agent launches.
 */
export function logDelegationRequested(
    logger: StructuredLogger | undefined,
    receipt: AgentDelegationReceipt,
    input: AgentDelegationCreate,
    caller: {
        isBot: boolean;
        parentDelegationId: string | undefined;
        terminalId: string | undefined;
        /**
         * How the target Session was started; `undefined` for a Session with no creator relation (the owner's, or one
         * Caxri Bot dispatched to).
         */
        relation: SessionRelation | undefined;
    },
): void {
    logger?.write('info', logEventCatalog.agentDelegation.requested, {
        fields: {
            delegationId: receipt.delegationId,
            projectId: input.projectId,
            sessionId: input.sessionId,
            provider: receipt.provider,
            mode: input.continueFromHandover
                ? 'handover'
                : input.resumeFrom
                  ? 'resume'
                  : input.followUpOf
                    ? 'follow_up'
                    : 'new',
            parentDelegationId: caller.parentDelegationId ?? null,
            relation: caller.relation ?? 'none',
            isBotCaller: caller.isBot,
            callerTerminalId: caller.terminalId ?? null,
        },
    });
}

/**
 * Records one `agent.delegation.retry` request with closed enums only. `reason` is a refusal's
 * `DelegationRetryUnavailableReason`, or `other` for an admission failure outside that list.
 */
export function logDelegationRetry(
    logger: StructuredLogger | undefined,
    fields: {
        delegationId: string;
        retryId?: string;
        mode: DelegationRetryMode;
        failure: AgentDelegationReceipt['failure'];
        outcome: 'started' | 'shared' | 'refused';
        reason?: DelegationRetryUnavailableReason | 'other';
        chainDepth: number;
    },
): void {
    logger?.write(
        fields.outcome === 'refused' ? 'warn' : 'info',
        logEventCatalog.agentDelegation.retryRequested,
        {
            fields: {
                delegationId: fields.delegationId,
                retryId: fields.retryId ?? null,
                mode: fields.mode,
                failure: fields.failure ?? null,
                outcome: fields.outcome,
                reason: fields.reason ?? null,
                chainDepth: fields.chainDepth,
            },
        },
    );
}
