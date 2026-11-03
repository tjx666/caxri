import type {
    AgentDelegationReceipt,
    DelegationRetryScheduleOutcome,
    DelegationRetryUnavailableReason,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import { RetryRefused } from './retry-support';

/**
 * Added to the provider's reset time before a scheduled retry runs, so the provider has actually reset: Chats that wait
 * for a usage limit use a 30 to 120 second stagger for the same reason. It is part of the persisted time
 * (`retryScheduledFor`), so the time a Client shows is the time the retry runs.
 */
export const RETRY_SCHEDULE_MARGIN_MS = 60_000;

/**
 * How often pending scheduled retries are checked. A retry starts at most this long after its time.
 */
export const RETRY_SCHEDULE_POLL_MS = 15_000;

/**
 * A schedule that comes due this long after its time (the Mac slept through it, or Server Core was not running) does
 * not run on its own: the user may have moved on. This is the Chat usage-limit wait's rule (`MISSED_AFTER_MS`), so the
 * two automatic continuations behave alike.
 */
export const RETRY_SCHEDULE_MISSED_AFTER_MS = 30 * 60_000;

/**
 * When a retry scheduled now would run: the failed task's reset time plus the margin, or `undefined` when the receipt
 * has no reset time or that time has already passed (retry now instead). A reset time is never guessed.
 */
export function scheduledRetryTime(
    receipt: Pick<AgentDelegationReceipt, 'failureResetsAt'>,
    now: number,
): number | undefined {
    if (receipt.failureResetsAt === undefined) return undefined;
    const at = receipt.failureResetsAt + RETRY_SCHEDULE_MARGIN_MS;
    return at > now ? at : undefined;
}

/**
 * The refusal reasons as the outcome a scheduled retry records. Reasons that only describe the pending schedule itself
 * or a mode that never applied read as `not_retryable`.
 */
const SCHEDULE_OUTCOMES = {
    human_input: 'human_input',
    target_changed: 'target_changed',
    session_changed: 'target_changed',
    target_busy: 'target_busy',
    caller_gone: 'caller_gone',
    worktree_gone: 'worktree_gone',
    no_provider_session: 'not_retryable',
    resume_unsupported: 'not_retryable',
    already_retried: 'not_retryable',
    not_retryable: 'not_retryable',
    no_reset_time: 'not_retryable',
    schedule_pending: 'not_retryable',
} as const satisfies Record<DelegationRetryUnavailableReason, DelegationRetryScheduleOutcome>;

/**
 * Why a scheduled retry failed before its task existed, as a closed outcome. A weekly usage guard that still holds is
 * `provider_guarded`; any other refusal of the launch itself is `launch_failed`; anything else is `internal_error`.
 */
export function scheduleOutcomeOf(error: unknown): DelegationRetryScheduleOutcome {
    if (error instanceof RetryRefused) return SCHEDULE_OUTCOMES[error.reason];
    if (error instanceof CaxriError)
        return error.code === 'USAGE_LIMITED' ? 'provider_guarded' : 'launch_failed';
    return 'internal_error';
}
