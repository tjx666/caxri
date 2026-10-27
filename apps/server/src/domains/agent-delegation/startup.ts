import { isDelegationActive } from '@caxri/protocol';

import type { StoredAgentDelegation } from '../db';
import { isAwaitingStartup } from './lifecycle';

/**
 * Settles a task whose Agent has not started its turn by the startup deadline. A dead launch never came up
 * (`startup_not_ready`). A live one is waiting on something only the user can answer, typically a first-run prompt such
 * as folder trust or sign-in, and stays recoverable as `blocked`/`startup_waiting`: the prompt is the provider's
 * security decision, whether one is showing cannot be known without reading Terminal content, and the task resumes on
 * its own once the native session starts. Returns nothing when the task already moved on.
 */
export function startupDeadlineOutcome(
    record: StoredAgentDelegation,
    isLaunchAlive: boolean,
): StoredAgentDelegation | 'startup_not_ready' | undefined {
    if (record.turnId || !isDelegationActive(record.receipt)) return undefined;
    if (isLaunchAlive && record.receipt.status === 'awaiting_ready')
        return {
            ...record,
            receipt: { ...record.receipt, status: 'blocked', failure: 'startup_waiting' },
        };
    return 'startup_not_ready';
}

/**
 * True for a task that relaunches an existing conversation (an exact resume, or Caxri Bot continuing a hand-over)
 * rather than starting a fresh one.
 */
function isConversationContinuation(record: StoredAgentDelegation): boolean {
    return Boolean(record.input.resumeFrom ?? record.input.continueFromHandover);
}

/**
 * Before a fresh Agent starts its turn, the user's input answers its startup prompt; there is no conversation to take
 * over yet, so it neither interrupts the task nor revokes its continuation authority. The caller carries the Terminal's
 * already advanced input epoch onto the task, so the fence guarding a later follow-up measures input after the turn,
 * not this answer. A resumed or handed-over task already has a conversation, so input there still counts as a
 * takeover.
 */
export function isStartupPromptInput(record: StoredAgentDelegation): boolean {
    return !isConversationContinuation(record) && isAwaitingStartup(record);
}

/**
 * What a Terminal interruption does to its active task: human input takes it over, and a Host-side interruption stops
 * it unless it belongs to a launch that is not the retired one. Returns nothing when the task must be left alone.
 */
export function interruptedDelegation(
    record: StoredAgentDelegation,
    isHumanInput: boolean,
    retiredLaunchId?: string,
): StoredAgentDelegation | undefined {
    if (!isHumanInput) {
        if (
            isConversationContinuation(record) &&
            !record.launchId &&
            record.receipt.status === 'launching'
        )
            return undefined;
        if (retiredLaunchId && record.launchId && record.launchId !== retiredLaunchId)
            return undefined;
    }
    return {
        ...record,
        receipt: {
            ...record.receipt,
            status: isHumanInput ? 'human_intervened' : 'interrupted',
            failure: isHumanInput ? 'human_input' : 'target_changed',
        },
    };
}
