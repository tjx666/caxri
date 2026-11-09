import type {
    AgentDelegationReceipt,
    DelegationRetryScheduleOutcome,
} from '../agent-delegation-contract.js';

/**
 * The failures an owner may retry: the provider or launch failed for a reason a second attempt can plausibly change. An
 * allowlist on purpose. Everything else (a stop, human input, a busy or not-ready target, an unconfirmed submission, a
 * missing answer) either was the user's own doing or leaves the earlier attempt's effects unknown.
 */
const RETRYABLE_FAILURES: ReadonlySet<NonNullable<AgentDelegationReceipt['failure']>> = new Set([
    'rate_limited',
    'authentication_failed',
    'output_limit',
    'startup_not_ready',
    'provider_failed',
    'launch_failed',
    'hooks_required',
    'quota_exhausted',
    'capacity_exhausted',
]);

/**
 * Whether a receipt is a failure `agent.delegation.retry` accepts: status `failed` (never `interrupted`) with an
 * allowlisted failure. A missing failure is not retryable.
 */
export function isRetryableDelegationFailure(
    receipt: Pick<AgentDelegationReceipt, 'status' | 'failure'>,
): boolean {
    return (
        receipt.status === 'failed' &&
        receipt.failure !== undefined &&
        RETRYABLE_FAILURES.has(receipt.failure)
    );
}

/**
 * The notice a delegating Agent receives when its failed task was retried. A wait that already returned `failed` is
 * finished and never learns of the retry, so this fixed text carries only the two task IDs and what to do.
 */
export function formatDelegationRetryNotice(failedId: string, retryId: string): string {
    return `Delegated task ${failedId} was retried as ${retryId}. Wait on ${retryId} for the result.`;
}

/**
 * The notice a delegating Agent receives when a scheduled retry of its failed task did not run. Fixed text: the two
 * values are a task ID and a closed outcome, nothing from the task.
 */
export function formatDelegationRetryRefusedNotice(
    failedId: string,
    outcome: DelegationRetryScheduleOutcome,
): string {
    return `The scheduled retry of delegated task ${failedId} did not run (${outcome}). The task stays failed; do not wait for a retry of it.`;
}
