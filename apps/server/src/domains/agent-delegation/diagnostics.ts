import type {
    AgentDelegationCreate,
    AgentDelegationReceipt,
    DelegationResultSource,
    DelegationRetryMode,
    DelegationRetryScheduleOutcome,
    DelegationRetryUnavailableReason,
    SessionRelation,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { ProjectAddOutcome } from '../project';

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
 * Records that a `projectPath` delegation resolved its folder to a Project. Closed values and a duration only, never
 * the path.
 */
export function logDelegationProjectAdded(
    logger: StructuredLogger | undefined,
    added: { outcome: ProjectAddOutcome; principalKind: string; durationMs: number },
): void {
    logger?.write('info', logEventCatalog.agentDelegation.projectAdded, { fields: added });
}

/**
 * Records one redirect decision. Closed values and counts only: never the text, the operation ID, or a path.
 */
export function logDelegationRedirect(
    logger: StructuredLogger | undefined,
    fields: {
        delegationId: string;
        outcome: 'delivered' | 'replayed' | 'refused' | 'unknown';
        reason: string | null;
        principalKind: string;
        textLength: number;
        redirectCount: number;
        durationMs: number;
    },
): void {
    logger?.write(
        fields.outcome === 'delivered' ? 'info' : 'warn',
        logEventCatalog.agentDelegation.redirected,
        {
            fields,
        },
    );
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
        /**
         * The Agent a switched retry runs on; absent for a retry on the failed task's own Agent.
         */
        toProvider?: AgentDelegationReceipt['provider'];
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
                toProvider: fields.toProvider ?? null,
                chainDepth: fields.chainDepth,
            },
        },
    );
}

/**
 * The closed transitions of a scheduled retry; see `agentDelegationLogEvents.retrySchedule`.
 */
export type RetryScheduleLogOutcome =
    | 'scheduled'
    | 'cancelled'
    | 'fired'
    | 'refused_at_fire'
    | 'missed_window'
    | 'restored'
    | 'session_gone'
    | 'human_input_cancelled'
    | 'successor_found'
    | 'record_gone';

/**
 * Records one state transition of a scheduled retry with closed enums and numbers only, never the task. `lateMs` is how
 * long after its time a fire ran, `waitMs` how long a new schedule waits, and `pending` and `overdue` count the
 * schedules found at Server start (logged once per start, not per record).
 */
export function logDelegationRetrySchedule(
    logger: StructuredLogger | undefined,
    fields: {
        outcome: RetryScheduleLogOutcome;
        delegationId?: string;
        successorId?: string;
        mode?: DelegationRetryMode;
        provider?: AgentDelegationReceipt['provider'];
        reason?: DelegationRetryScheduleOutcome;
        scheduledFor?: number;
        lateMs?: number;
        waitMs?: number;
        chainDepth?: number;
        pending?: number;
        overdue?: number;
    },
): void {
    const isProblem = ['refused_at_fire', 'missed_window', 'record_gone'].includes(fields.outcome);
    logger?.write(isProblem ? 'warn' : 'info', logEventCatalog.agentDelegation.retrySchedule, {
        fields: {
            outcome: fields.outcome,
            delegationId: fields.delegationId ?? null,
            successorId: fields.successorId ?? null,
            mode: fields.mode ?? null,
            provider: fields.provider ?? null,
            reason: fields.reason ?? null,
            scheduledFor: fields.scheduledFor ?? null,
            lateMs: fields.lateMs ?? null,
            waitMs: fields.waitMs ?? null,
            chainDepth: fields.chainDepth ?? null,
            pending: fields.pending ?? null,
            overdue: fields.overdue ?? null,
        },
    });
}
