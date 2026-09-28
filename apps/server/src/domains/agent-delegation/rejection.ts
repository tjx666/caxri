import type { AgentDelegationReceipt } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { StoredAgentDelegation } from '../db';
import type { AgentDelegationServiceOptions } from './service-options';

type DelegationFailure = NonNullable<AgentDelegationReceipt['failure']>;

/**
 * Why a follow-up prompt was refused at admission, as a closed enum.
 *
 * The receipt only carries the coarse `failure` the caller is shown, and five separate conditions collapse into
 * `target_changed` alone. An intermittent CI failure (#877, tracked in #933) stalled for exactly that reason: the
 * record named the category but never the condition, so each investigation had to re-derive which of the five had
 * fired, and none of them could. Every branch names itself here, and the service reports the name beside the failure.
 */
const delegationFollowUpRejections = {
    /**
     * The parent already handed its Terminal to another follow-up.
     */
    parent_chained: 'target_busy',
    /**
     * Another task is still running on the parent's Terminal.
     */
    terminal_busy: 'target_busy',
    /**
     * The parent never had, or no longer has, a Terminal.
     */
    no_terminal: 'target_changed',
    /**
     * The parent recorded that its Terminal stopped being the task's target.
     */
    target_lost: 'target_changed',
    /**
     * The parent has no launch to write to.
     */
    no_launch: 'target_changed',
    /**
     * The parent has no provider Session, so a follow-up has nothing to continue.
     */
    no_provider_session: 'target_changed',
    /**
     * The Terminal is running a different Agent launch than the parent's.
     */
    launch_replaced: 'target_changed',
    /**
     * The parent recorded a human typing into its Terminal.
     */
    human_intervened: 'human_input',
    /**
     * The parent never captured an input epoch, so human input cannot be ruled out.
     */
    no_input_epoch: 'human_input',
    /**
     * The Terminal's input epoch advanced since the parent captured it.
     */
    input_epoch_moved: 'human_input',
    /**
     * The parent has no turn, so there is no idle proof to check.
     */
    no_turn: 'target_not_ready',
    /**
     * The Agent is not idle at the parent's turn.
     */
    target_not_idle: 'target_not_ready',
    /**
     * The Terminal Host refused the write after admission.
     */
    write_refused: 'target_changed',
} as const satisfies Record<string, DelegationFailure>;

/**
 * Why an exact resume was refused at admission, as a closed enum.
 *
 * Kept separate from {@link delegationFollowUpRejections} because the same words mean different outcomes here: a resume
 * without a Terminal is a changed Session, while a follow-up without one is a changed target. The report carries the
 * phase so a reader never has to guess which table a name came from.
 */
const delegationResumeRejections = {
    /**
     * The parent never had, or no longer has, a Terminal.
     */
    no_terminal: 'session_changed',
    /**
     * The parent has no provider Session to resume.
     */
    no_provider_session: 'session_changed',
    /**
     * The Terminal is attached to a different provider Session than the parent's.
     */
    provider_session_replaced: 'session_changed',
    /**
     * The parent already handed its Terminal to another follow-up.
     */
    parent_chained: 'target_busy',
    /**
     * Another task is still running on the parent's Terminal.
     */
    terminal_busy: 'target_busy',
    /**
     * The parent recorded that its Terminal stopped being the task's target.
     */
    target_lost: 'target_changed',
    /**
     * The Terminal is running a different Agent launch than the parent's.
     */
    launch_replaced: 'target_changed',
    /**
     * The parent recorded a human typing into its Terminal.
     */
    human_intervened: 'human_input',
    /**
     * The parent never captured an input epoch, so human input cannot be ruled out.
     */
    no_input_epoch: 'human_input',
    /**
     * The Terminal's input epoch advanced since the parent captured it.
     */
    input_epoch_moved: 'human_input',
    /**
     * The parent's own receipt already ended in human input.
     */
    parent_human_intervened: 'human_input',
    /**
     * This build has no resume dispatcher, so an exact resume cannot be attempted.
     */
    resume_unsupported: 'target_not_ready',
} as const satisfies Record<string, DelegationFailure>;

export type DelegationFollowUpRejection = keyof typeof delegationFollowUpRejections;
export type DelegationResumeRejection = keyof typeof delegationResumeRejections;

/**
 * Resolves the caller-visible failure for a refused admission and records the condition that produced it.
 *
 * The phase travels with the reason because the two tables reuse names for different outcomes, so a reader never has to
 * guess which one a record came from. The logger is optional for the same reason the service's is: a unit test builds
 * the service without the Server around it.
 */
function report(
    logger: StructuredLogger | undefined,
    delegationId: string,
    phase: 'follow_up' | 'resume',
    reason: string,
    failure: DelegationFailure,
): DelegationFailure {
    logger?.write('info', logEventCatalog.agentDelegation.admissionRejected, {
        fields: { delegationId, phase, reason, failure },
    });
    return failure;
}

export function reportFollowUpRejection(
    logger: StructuredLogger | undefined,
    delegationId: string,
    reason: DelegationFollowUpRejection,
): DelegationFailure {
    return report(logger, delegationId, 'follow_up', reason, delegationFollowUpRejections[reason]);
}

export function reportResumeRejection(
    logger: StructuredLogger | undefined,
    delegationId: string,
    reason: DelegationResumeRejection,
): DelegationFailure {
    return report(logger, delegationId, 'resume', reason, delegationResumeRejections[reason]);
}

/**
 * The live Terminal reads an admission checks a parent task against. A missing Terminal host reads as no launch, no
 * epoch, and never idle.
 */
type DelegationTarget = Pick<
    AgentDelegationServiceOptions,
    'currentLaunchId' | 'database' | 'dispatch' | 'inputEpoch' | 'isIdle'
>;

/**
 * The first condition that keeps a follow-up from reaching its parent's live launch, in admission order.
 */
export function followUpRejection(
    parent: StoredAgentDelegation,
    target: DelegationTarget,
    isBusy: (terminalId: string) => boolean,
): DelegationFollowUpRejection | undefined {
    const { terminalId } = parent.receipt;
    if (parent.nextDelegationId) return 'parent_chained';
    if (terminalId && isBusy(terminalId)) return 'terminal_busy';
    if (!terminalId) return 'no_terminal';
    if (parent.hasLostTarget) return 'target_lost';
    if (!parent.launchId) return 'no_launch';
    if (!parent.providerSessionId) return 'no_provider_session';
    if (target.currentLaunchId?.(terminalId) !== parent.launchId) return 'launch_replaced';
    if (parent.hasHumanIntervention) return 'human_intervened';
    if (parent.inputEpoch === undefined) return 'no_input_epoch';
    if (target.inputEpoch?.(terminalId) !== parent.inputEpoch) return 'input_epoch_moved';
    if (!parent.turnId) return 'no_turn';
    if (!target.isIdle?.(terminalId, parent.launchId, parent.turnId)) return 'target_not_idle';
    return undefined;
}

/**
 * The first condition that keeps an exact resume from relaunching its parent's conversation, in admission order.
 */
export function resumeRejection(
    parent: StoredAgentDelegation,
    target: DelegationTarget,
    isBusy: (terminalId: string) => boolean,
): DelegationResumeRejection | undefined {
    const { terminalId } = parent.receipt;
    if (!terminalId) return 'no_terminal';
    if (!parent.providerSessionId) return 'no_provider_session';
    if (target.database.getTerminal(terminalId)?.agentSessionId !== parent.providerSessionId)
        return 'provider_session_replaced';
    if (parent.nextDelegationId) return 'parent_chained';
    if (isBusy(terminalId)) return 'terminal_busy';
    if (parent.hasLostTarget) return 'target_lost';
    const currentLaunchId = target.currentLaunchId?.(terminalId);
    if (currentLaunchId && currentLaunchId !== parent.launchId) return 'launch_replaced';
    if (parent.hasHumanIntervention) return 'human_intervened';
    if (parent.inputEpoch === undefined) return 'no_input_epoch';
    if (target.inputEpoch?.(terminalId) !== parent.inputEpoch) return 'input_epoch_moved';
    if (parent.receipt.status === 'human_intervened' || parent.receipt.failure === 'human_input')
        return 'parent_human_intervened';
    if (!target.dispatch.resume) return 'resume_unsupported';
    return undefined;
}
