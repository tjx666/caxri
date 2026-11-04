import type { StoredAgentDelegation } from '../db';
import type { DelegationApprovals } from './approvals/service';
import { withHumanIntervention } from './lifecycle';
import type { DelegationQuestions } from './questions/service';
import type { AgentDelegationServiceOptions } from './service-options';
import { interruptedDelegation, isStartupPromptInput } from './startup';

/**
 * What {@link interruptDelegationTerminal} borrows from the service.
 */
export interface InterruptHost {
    options: Pick<AgentDelegationServiceOptions, 'database' | 'inputEpoch'>;
    questions: DelegationQuestions;
    approvals: DelegationApprovals;
    now(): number;
    activeForTerminal(terminalId: string): StoredAgentDelegation | undefined;
    save(record: StoredAgentDelegation): StoredAgentDelegation;
}

/**
 * A Terminal's Agent was interrupted, or its launch retired: closes what depended on it and settles the active task.
 */
export function interruptDelegationTerminal(
    host: InterruptHost,
    terminalId: string,
    isHumanInput: boolean,
    retiredLaunchId?: string,
): void {
    const starting = host.activeForTerminal(terminalId);
    if (isHumanInput && starting && isStartupPromptInput(starting)) {
        host.save({ ...starting, inputEpoch: host.options.inputEpoch?.(terminalId) });
        return;
    }
    host.questions.interrupted(
        terminalId,
        starting?.receipt.delegationId,
        isHumanInput,
        retiredLaunchId,
    );
    host.approvals.interrupted(terminalId, isHumanInput, retiredLaunchId);
    // A completed answer stays readable, but takeover revokes its continuation authority for good. Persisted on
    // each task that still lacks the mark (the input epoch alone is lost on restart), dated for the feed's
    // `takenOverAt`. Deliberately not guarded per Terminal: a task delegated into a Terminal the user already
    // typed in must still be marked by the next input.
    if (isHumanInput)
        for (const task of host.options.database.agentDelegations.forTerminal(terminalId))
            if (!task.hasHumanIntervention) host.save(withHumanIntervention(task, host.now()));
    // Re-read: the takeover mark above may have just rewritten the active task.
    const record = host.activeForTerminal(terminalId);
    const next = record && interruptedDelegation(record, isHumanInput, retiredLaunchId);
    if (next) host.save(next);
}
