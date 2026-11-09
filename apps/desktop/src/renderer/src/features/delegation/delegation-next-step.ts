import type { AgentDelegationReceipt } from '@caxri/protocol';

type AgentDelegationFailure = NonNullable<AgentDelegationReceipt['failure']>;

/**
 * What a failed delegated task's row offers the user to do next, as a closed set:
 *
 * - `retry`: the Retry menu (the Server still decides which modes are open).
 * - `signIn`: type the Agent's sign-in command into a new Shell Session.
 * - `enableHooks`: open Settings at the provider's lifecycle hooks row.
 * - `openSession`: read the child Session; the row's own click target, with no further action.
 */
export type DelegationNextStepKind = 'enableHooks' | 'openSession' | 'retry' | 'signIn';

/**
 * The next steps of every failure, in the order the row shows them. A `Record` over the protocol enum, so a new failure
 * value fails the type check until it names its next step. `retry` appears exactly for the failures
 * `isRetryableDelegationFailure` allows (a unit test pins the two together). `submission_unconfirmed` is `openSession`
 * only on purpose: whether the task reached the Agent is unknown, so a second attempt could run it twice.
 */
const FAILURE_NEXT_STEPS: Readonly<
    Record<AgentDelegationFailure, readonly DelegationNextStepKind[]>
> = {
    rate_limited: ['retry'],
    quota_exhausted: ['retry'],
    authentication_failed: ['signIn', 'retry'],
    hooks_required: ['enableHooks', 'retry'],
    output_limit: ['retry'],
    startup_not_ready: ['retry'],
    launch_failed: ['retry'],
    capacity_exhausted: ['retry'],
    provider_failed: ['retry'],
    submission_unconfirmed: ['openSession'],
    startup_waiting: ['openSession'],
    permission_required: ['openSession'],
    target_changed: ['openSession'],
    session_changed: ['openSession'],
    human_input: ['openSession'],
    host_reset: ['openSession'],
    result_missing: ['openSession'],
    payload_overflow: ['openSession'],
    correlation_missing: ['openSession'],
    caller_stopped: ['openSession'],
    target_not_ready: ['openSession'],
    target_busy: ['openSession'],
};

/**
 * The next steps a task's failure offers; `openSession` alone when the task has no failure.
 */
export function delegationNextSteps(
    failure: AgentDelegationFailure | undefined,
): readonly DelegationNextStepKind[] {
    return failure === undefined ? ['openSession'] : FAILURE_NEXT_STEPS[failure];
}
