import type {
    AgentDelegationReceipt,
    AgentDelegationSession,
    AgentProvider,
    DelegationRetryScheduleOutcome,
    DelegationWaitingOn,
} from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { localizedLimitReset } from '../../lib/usage-format';
import { isDelegationRetryPending } from './delegation-feed';
import { formatRetryTime } from './delegation-retry-time';

type AgentDelegationFailure = NonNullable<AgentDelegationReceipt['failure']>;
type AgentDelegationStatus = AgentDelegationReceipt['status'];

/**
 * The state of one delegated task as the Chat surfaces word it: the fields of a feed entry
 * (`agent.delegation.sessions`) or of a task-state read (`agent.delegation.statuses`) that decide the copy.
 */
export interface DelegationCopyInput {
    failure?: AgentDelegationFailure;
    /**
     * When the provider's own limit resets, in epoch milliseconds, as the Server recorded it. Shown only while it is in
     * the future.
     */
    failureResetsAt?: number;
    provider?: AgentProvider;
    /**
     * The reserved successor of a retry claim and, while a scheduled retry is pending, the time it runs. Together they
     * mean "retry scheduled"; `retriedAs` alone is a retry that started.
     */
    retriedAs?: string;
    retryScheduledFor?: number;
    /**
     * Why the last scheduled retry did not run, folded into the failure's detail line.
     */
    retryScheduleOutcome?: DelegationRetryScheduleOutcome;
    status?: AgentDelegationStatus;
    /**
     * Who the task's open question waits on, from the feed. Only a running task wears it: a question closes when the
     * task ends.
     */
    waitingOn?: DelegationWaitingOn;
}

/**
 * Which status glyph a task wears, in the sidebar's shapes: an amber question mark for a task that needs the user, the
 * running arc while it works, the slow dotted ring while it asks the Agent that delegated it, a red cross for a
 * failure, a muted clock for a failure whose retry is scheduled, and the ordinary Agent glyph for everything else
 * (completed, stopped, taken over, finished without a readable result).
 */
export type DelegationGlyph =
    'asking' | 'failed' | 'needsInput' | 'ordinary' | 'running' | 'waiting';

/**
 * What the row offers beyond its own click target. The only action is opening the child Session, and only where the
 * state asks the user to look at it.
 */
type DelegationPrimaryAction = 'none' | 'openSession';

export interface DelegationCopy {
    /**
     * The next step or the cause, one short line; absent when the headline says it all.
     */
    detail?: string;
    glyph: DelegationGlyph;
    /**
     * The state in one short line.
     */
    headline: string;
    primaryAction: DelegationPrimaryAction;
}

const STARTING: ReadonlySet<AgentDelegationStatus> = new Set([
    'requested',
    'launching',
    'awaiting_ready',
    'submitting',
]);

function providerName(provider: AgentProvider | undefined, t: Translate): string {
    return provider
        ? agentProviderCatalog[provider].displayName
        : t('delegation.copy.agentFallback');
}

/**
 * A failure the task finished or stopped with, worded for the status it rides on. Returns `undefined` for a failure
 * with no copy of its own, so the caller falls back to its status headline.
 */
function failureCopy(
    failure: AgentDelegationFailure,
    input: DelegationCopyInput,
    now: number,
    t: Translate,
): Omit<DelegationCopy, 'primaryAction'> | undefined {
    const provider = providerName(input.provider, t);
    const failed = (headlineKey: Parameters<Translate>[0], detail?: string) => ({
        glyph: 'failed' as const,
        headline: t(headlineKey, { provider }),
        ...(detail && { detail }),
    });
    switch (failure) {
        case 'quota_exhausted':
        case 'rate_limited': {
            // A clock is shown only for a reset the Server recorded and that is still ahead; it never infers a window.
            const isResetAhead = input.failureResetsAt !== undefined && input.failureResetsAt > now;
            return failed(
                'delegation.copy.usageLimit',
                isResetAhead ? localizedLimitReset(input.failureResetsAt!, now, t) : undefined,
            );
        }
        case 'authentication_failed': {
            return failed('delegation.copy.notSignedIn');
        }
        case 'startup_not_ready':
        case 'launch_failed': {
            return failed('delegation.copy.couldNotStart');
        }
        case 'hooks_required': {
            return failed(
                'delegation.copy.hooksRequired',
                t('delegation.copy.hooksRequiredDetail', { provider }),
            );
        }
        case 'provider_failed': {
            return failed('delegation.copy.providerFailed');
        }
        case 'output_limit': {
            return failed('delegation.copy.outputLimit');
        }
        case 'submission_unconfirmed': {
            return failed('delegation.copy.submissionUnconfirmed');
        }
        case 'session_changed': {
            return { glyph: 'ordinary', headline: t('delegation.copy.sessionChanged') };
        }
        case 'host_reset': {
            return {
                glyph: 'ordinary',
                headline: t('delegation.copy.interrupted'),
                detail: t('delegation.copy.interruptedHostReset'),
            };
        }
        case 'target_changed': {
            return {
                glyph: 'ordinary',
                headline: t('delegation.copy.interrupted'),
                detail: t('delegation.copy.interruptedTargetChanged'),
            };
        }
        case 'caller_stopped': {
            return {
                glyph: 'ordinary',
                headline: t('delegation.copy.stopped'),
                detail: t('delegation.copy.stoppedDetail'),
            };
        }
        case 'human_input': {
            return {
                glyph: 'ordinary',
                headline: t('delegation.copy.takenOver'),
                detail: t('delegation.copy.takenOverDetail'),
            };
        }
        case 'startup_waiting': {
            return {
                glyph: 'needsInput',
                headline: t('delegation.copy.needsInput'),
                detail: t('delegation.copy.needsInputStartup'),
            };
        }
        case 'permission_required': {
            return {
                glyph: 'needsInput',
                headline: t('delegation.copy.needsInput'),
                detail: t('delegation.copy.needsInputRequest'),
            };
        }
        case 'result_missing': {
            return unreadableResult(t('delegation.copy.resultMissing'), t);
        }
        case 'correlation_missing': {
            return unreadableResult(t('delegation.copy.resultUncorrelated'), t);
        }
        case 'payload_overflow': {
            return unreadableResult(t('delegation.copy.resultTooLong'), t);
        }
        case 'target_busy': {
            return {
                glyph: 'ordinary',
                headline: t('delegation.copy.notRun'),
                detail: t('delegation.copy.notRunBusy'),
            };
        }
        case 'target_not_ready': {
            return {
                glyph: 'ordinary',
                headline: t('delegation.copy.notRun'),
                detail: t('delegation.copy.notRunNotReady'),
            };
        }
    }
}

/**
 * The work may be done: the glyph is the ordinary one, never the red cross, and the user is pointed at the Session to
 * read the answer.
 */
function unreadableResult(detail: string, t: Translate): Omit<DelegationCopy, 'primaryAction'> {
    return {
        glyph: 'ordinary',
        headline: t('delegation.copy.resultUnreadable'),
        detail,
    };
}

/**
 * The failures whose copy asks the user to look at the Session: something to answer, a failure to read, or a result to
 * find by hand. Everything else is a state the row explains by itself.
 */
function isOpenSessionAsked(
    copy: Pick<DelegationCopy, 'glyph'>,
    status: AgentDelegationStatus,
): boolean {
    return (
        copy.glyph === 'failed' || copy.glyph === 'needsInput' || status === 'answer_unavailable'
    );
}

/**
 * Words one task's state for the Delegated Sessions strip, the timeline record, and the delegated child's row, so the
 * three never disagree. Pure: `now` is passed in (the callers tick it by the minute) and `t` is the interface's
 * translator.
 *
 * `status` decides the shape and `failure` the wording of the statuses that carry one (`failed`, `interrupted`,
 * `blocked`, `answer_unavailable`, `human_intervened`); an active or completed task ignores a stray failure. A reset
 * time appears only for a recorded `failureResetsAt` that is still ahead of `now`. `primaryAction` is only opening the
 * Session: Retry is not derived from the status alone (the Server decides which modes are open, see
 * `useDelegationRetryOptions`), so it is a separate control.
 */
export function delegationCopy(
    input: DelegationCopyInput,
    now: number,
    t: Translate,
): DelegationCopy {
    const { failure, status } = input;
    if (status === undefined)
        return { glyph: 'ordinary', headline: t('delegation.copy.noTask'), primaryAction: 'none' };
    if (STARTING.has(status))
        return {
            glyph: 'running',
            headline: t('delegation.copy.starting', { provider: providerName(input.provider, t) }),
            primaryAction: 'none',
        };
    if (status === 'running' && input.waitingOn === 'parent')
        return {
            glyph: 'asking',
            headline: t('delegation.copy.askingParent'),
            primaryAction: 'none',
        };
    if (status === 'running' && input.waitingOn === 'user')
        return {
            glyph: 'needsInput',
            headline: t('delegation.copy.askingYou'),
            primaryAction: 'openSession',
        };
    if (status === 'running')
        return { glyph: 'running', headline: t('delegation.copy.working'), primaryAction: 'none' };
    if (status === 'collecting')
        return {
            glyph: 'running',
            headline: t('delegation.copy.collecting'),
            primaryAction: 'none',
        };
    if (status === 'completed')
        return {
            glyph: 'ordinary',
            headline: t('delegation.copy.completed'),
            primaryAction: 'none',
        };
    if (status === 'failed' && isDelegationRetryPending(input))
        return {
            glyph: 'waiting',
            headline: t('delegation.copy.retryPending', {
                time: formatRetryTime(input.retryScheduledFor!, now, t),
            }),
            primaryAction: 'none',
        };
    const base = (failure && failureCopy(failure, input, now, t)) ?? statusCopy(status, t);
    const copy = withScheduleOutcome(base, input.retryScheduleOutcome, t);
    return { ...copy, primaryAction: isOpenSessionAsked(copy, status) ? 'openSession' : 'none' };
}

/**
 * Folds a refused scheduled retry into the failure's own detail line, so the refusal stays with the failure until the
 * user acts on it and no separate notice row exists.
 */
function withScheduleOutcome(
    copy: Omit<DelegationCopy, 'primaryAction'>,
    outcome: DelegationRetryScheduleOutcome | undefined,
    t: Translate,
): Omit<DelegationCopy, 'primaryAction'> {
    if (outcome === undefined) return copy;
    const refusal = t(`delegation.retry.outcome.${outcome}`);
    return { ...copy, detail: copy.detail ? `${copy.detail} · ${refusal}` : refusal };
}

/**
 * The wording of a settled or waiting status that carries no failure of its own.
 */
function statusCopy(
    status: AgentDelegationStatus,
    t: Translate,
): Omit<DelegationCopy, 'primaryAction'> {
    switch (status) {
        case 'blocked': {
            return { glyph: 'needsInput', headline: t('delegation.copy.needsInput') };
        }
        case 'human_intervened': {
            return {
                glyph: 'ordinary',
                headline: t('delegation.copy.takenOver'),
                detail: t('delegation.copy.takenOverDetail'),
            };
        }
        case 'interrupted': {
            return { glyph: 'ordinary', headline: t('delegation.copy.interrupted') };
        }
        case 'answer_unavailable': {
            return { glyph: 'ordinary', headline: t('delegation.copy.resultUnreadable') };
        }
        default: {
            return { glyph: 'failed', headline: t('delegation.copy.failed') };
        }
    }
}

/**
 * The input a feed entry gives {@link delegationCopy}.
 */
export function delegationCopyInput(
    entry: Pick<AgentDelegationSession, 'failure' | 'failureResetsAt' | 'provider' | 'status'> &
        Partial<
            Pick<
                AgentDelegationSession,
                'retriedAs' | 'retryScheduledFor' | 'retryScheduleOutcome' | 'waitingOn'
            >
        >,
): DelegationCopyInput {
    return {
        ...(entry.retriedAs && { retriedAs: entry.retriedAs }),
        ...(entry.retryScheduledFor !== undefined && {
            retryScheduledFor: entry.retryScheduledFor,
        }),
        ...(entry.retryScheduleOutcome && { retryScheduleOutcome: entry.retryScheduleOutcome }),
        ...(entry.failure && { failure: entry.failure }),
        ...(entry.failureResetsAt !== undefined && { failureResetsAt: entry.failureResetsAt }),
        ...(entry.provider && { provider: entry.provider }),
        ...(entry.status && { status: entry.status }),
        ...(entry.waitingOn && { waitingOn: entry.waitingOn }),
    };
}
