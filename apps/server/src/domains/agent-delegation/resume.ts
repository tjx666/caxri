import type {
    AgentDelegationCreate,
    AgentDelegationReceipt,
    CommanderHandoverTarget,
} from '@caxri/protocol';
import { CaxriError, isDelegationActive } from '@caxri/protocol';

import type { StoredAgentDelegation } from '../db';
import type { DelegationAuthority } from './admission';
import { isAgentCommanderCaller } from './admission';
import { delegationResumeLaunch, prepareDelegationFollowUp } from './launch';
import type { DelegationResumeRejection } from './rejection';
import { reportResumeRejection, resumeRejection } from './rejection';
import type { AgentDelegationServiceOptions } from './service-options';

/**
 * What an exact resume borrows from the delegation service, already bound to the caller's authority.
 */
export interface ExactResumeHost {
    options: AgentDelegationServiceOptions;
    owned(delegationId: string): StoredAgentDelegation;
    save(record: StoredAgentDelegation): StoredAgentDelegation;
    fail(delegationId: string, failure: AgentDelegationReceipt['failure']): void;
    isDeleting(sessionId: string): boolean;
    /**
     * True while another task is active on the Terminal.
     */
    hasActiveTask(terminalId: string): boolean;
}

/**
 * Relaunches one exact native conversation with a task pointer as its first prompt. The launch is fenced twice: it must
 * still be the task's when the process restarts, and nobody may have typed into the Terminal since `inputEpoch`.
 */
async function launchExactResume(
    host: ExactResumeHost,
    record: StoredAgentDelegation,
    authority: DelegationAuthority,
    resume: {
        terminalId: string;
        providerSessionId: string;
        inputEpoch: number | undefined;
        pointer: string;
        expectedLaunchId: string | undefined;
    },
): Promise<AgentDelegationReceipt> {
    const { options } = host;
    const id = record.receipt.delegationId;
    const { terminalId, inputEpoch, expectedLaunchId } = resume;
    const shouldStart = () => {
        const current = options.database.agentDelegations.get(id);
        return (
            current !== undefined &&
            isDelegationActive(current.receipt) &&
            !host.isDeleting(record.input.sessionId) &&
            options.inputEpoch?.(terminalId) === inputEpoch
        );
    };
    const dispatched = await options.dispatch.resume!(
        id,
        authority.principal,
        {
            projectId: record.input.projectId,
            sessionId: record.input.sessionId,
            terminalId,
            providerSessionId: resume.providerSessionId,
        },
        {
            delegationId: id,
            launch: delegationResumeLaunch(record, options.userDataPath),
            initialPrompt: resume.pointer,
            replaceLaunchId: expectedLaunchId,
            shouldStart,
            beforeResume: () => {
                if (!shouldStart() || options.currentLaunchId?.(terminalId) !== expectedLaunchId)
                    throw new CaxriError(
                        'CONFLICT',
                        'Delegation ownership changed before exact resume',
                    );
            },
        },
    );
    if (dispatched.status === 'failed') host.fail(id, 'launch_failed');
    return host.owned(id).receipt;
}

/**
 * `--resume-from`: continues a settled task's native conversation in its own Terminal.
 */
export async function resumeTask(
    host: ExactResumeHost,
    record: StoredAgentDelegation,
    authority: DelegationAuthority,
    previous: StoredAgentDelegation,
): Promise<AgentDelegationReceipt> {
    const { options } = host;
    const id = record.receipt.delegationId;
    const prepared = await prepareDelegationFollowUp(
        options.userDataPath,
        record.rootDelegationId!,
        id,
        [record.frozenInstructions, record.input.prompt].filter(Boolean).join('\n\n'),
    );
    const parent = host.owned(previous.receipt.delegationId);
    const reject = (reason: DelegationResumeRejection) => {
        host.fail(id, reportResumeRejection(options.logger, id, reason));
        return host.owned(id).receipt;
    };
    if (!isDelegationActive(host.owned(id).receipt)) return host.owned(id).receipt;
    const rejection = resumeRejection(parent, options, (terminalId) =>
        host.hasActiveTask(terminalId),
    );
    if (rejection) return reject(rejection);
    const terminalId = parent.receipt.terminalId!;
    const expectedLaunchId = options.currentLaunchId?.(terminalId);
    host.save({ ...parent, nextDelegationId: id });
    const saved = host.save({
        ...record,
        promptDigest: prepared.promptDigest,
        inputEpoch: parent.inputEpoch,
        receipt: { ...record.receipt, terminalId, status: 'launching' },
    });
    return launchExactResume(host, saved, authority, {
        terminalId,
        providerSessionId: parent.providerSessionId!,
        inputEpoch: parent.inputEpoch,
        pointer: prepared.pointer,
        expectedLaunchId,
    });
}

/**
 * The conversation a Commander hand-over lets this task continue, refused unless it can be continued right now: the
 * caller is the Commander, the hand-over is unconsumed, and its Agent still holds the conversation and is between
 * turns. Refused before any record exists, so the Commander simply retries once its `ready` notice arrives.
 */
export function handoverTarget(
    options: AgentDelegationServiceOptions,
    authority: DelegationAuthority,
    input: AgentDelegationCreate & { continueFromHandover: string },
    hasActiveTask: (terminalId: string) => boolean,
): CommanderHandoverTarget {
    const handovers = options.commanderHandovers;
    if (!handovers || !isAgentCommanderCaller(options.database, authority))
        throw new CaxriError('FORBIDDEN', 'Only the Agent Commander can continue a hand-over');
    if (!options.dispatch.resume)
        throw new CaxriError('UNAVAILABLE', 'This build cannot resume an Agent conversation');
    const target = handovers.target(input.continueFromHandover, input.sessionId);
    const terminal = options.database.getTerminal(target.terminalId);
    if (terminal?.sessionId !== input.sessionId)
        throw new CaxriError('CONFLICT', 'Handed-over Agent Terminal was closed');
    if (terminal.agentSessionId !== target.providerSessionId)
        throw new CaxriError(
            'CONFLICT',
            'Handed-over Agent moved to another conversation; start a new task in the Session instead',
        );
    if (hasActiveTask(target.terminalId) || handovers.isBusy(input.sessionId, target.terminalId))
        throw new CaxriError(
            'CONFLICT',
            'Handed-over Agent is still in a turn; wait for its ready notice',
        );
    return target;
}

/**
 * `--continue-handover`: the Commander's first task in a handed-over Session, an exact resume of the Session's own
 * conversation that carries the delegation's launch environment, so lifecycle correlation, waits, results, and later
 * follow-ups work as for any Commander task. The task file lives in this delegation's own private directory, which
 * becomes the root of the chain.
 */
export async function continueHandover(
    host: ExactResumeHost,
    record: StoredAgentDelegation,
    authority: DelegationAuthority,
    target: CommanderHandoverTarget,
): Promise<AgentDelegationReceipt> {
    const { options } = host;
    const id = record.receipt.delegationId;
    const { terminalId } = target;
    /**
     * Captured before the first await: a keystroke while the task file is written takes the Session back, and the
     * launch fence must see it.
     */
    const inputEpoch = options.inputEpoch?.(terminalId);
    const prepared = await prepareDelegationFollowUp(
        options.userDataPath,
        id,
        id,
        [record.frozenInstructions, record.input.prompt].filter(Boolean).join('\n\n'),
    );
    const current = host.owned(id);
    if (!isDelegationActive(current.receipt)) return current.receipt;
    const saved = host.save({
        ...current,
        promptDigest: prepared.promptDigest,
        inputEpoch,
        receipt: { ...current.receipt, terminalId, status: 'launching' },
    });
    return launchExactResume(host, saved, authority, {
        terminalId,
        providerSessionId: target.providerSessionId,
        inputEpoch,
        pointer: prepared.pointer,
        expectedLaunchId: options.currentLaunchId?.(terminalId),
    });
}
