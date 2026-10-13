import type {
    AgentDelegationCreate,
    AgentDelegationReceipt,
    CommanderHandoverTarget,
} from '@caxri/protocol';
import { CaxriError, isChatTerminal, isDelegationActive } from '@caxri/protocol';

import type { StoredAgentDelegation } from '../db';
import type { DelegationAuthority } from './admission';
import { isAgentCommanderCaller } from './admission';
import { canChatCorrelateTask } from './chat-child';
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
    /**
     * `DelegationSubmissions.submit`: writes a `submitting` task's pointer into one exact live launch.
     */
    submit(id: string, terminalId: string, launchId: string, pointer: string): boolean;
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
    try {
        return await launchExactResume(host, saved, authority, {
            terminalId,
            providerSessionId: parent.providerSessionId!,
            inputEpoch: parent.inputEpoch,
            pointer: prepared.pointer,
            expectedLaunchId,
        });
    } catch (error) {
        /**
         * Dispatch refused the resume before it recorded a receipt (a live Agent it may not replace, a changed
         * binding), so nothing reached the conversation: return the parent's chain claim, as a refused follow-up does,
         * or every later resume or follow-up of the parent would fail `parent_chained`.
         */
        if (!options.database.getAgentDispatch(id)) {
            host.save({ ...host.owned(id), hasLostTarget: true });
            host.save({
                ...host.owned(previous.receipt.delegationId),
                nextDelegationId: undefined,
            });
        }
        throw error;
    }
}

/**
 * A hand-over admitted for continuation: its target, and the input epoch read in the same synchronous step that
 * validated it, so human input after that step fences the continuation.
 */
export interface HandoverAdmission {
    target: CommanderHandoverTarget;
    inputEpoch: number | undefined;
}

type HandoverRequest = Parameters<typeof handoverTarget>;

/**
 * The conversation a Commander hand-over lets this task continue, refused unless it can be continued right now: the
 * caller is the Commander, the hand-over is unconsumed, and its Agent still holds the conversation, is between turns,
 * and (for a Chat) can correlate the task and is not starting or stopping. Refused before any record exists, so the
 * Commander simply retries once its `ready` notice arrives.
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
    const isChat = isChatTerminal(terminal);
    // Hand-overs recorded before Grok Build Chats became ownership-only can still name one as a target.
    if (isChat && !canChatCorrelateTask(target.provider))
        throw new CaxriError(
            'CONFLICT',
            "Handed-over Agent Chat's provider cannot carry a Commander task; start a new task in the Session instead",
        );
    if (hasActiveTask(target.terminalId) || handovers.isBusy(input.sessionId, target.terminalId))
        throw new CaxriError(
            'CONFLICT',
            'Handed-over Agent is still in a turn; wait for its ready notice',
        );
    /**
     * A Chat that is live with no live launch is starting or being suspended: neither a message nor an exact resume
     * (which may not replace a live Agent without its launch id) can reach it yet.
     */
    if (
        isChat &&
        options.isChatLive?.(target.terminalId) &&
        !options.currentLaunchId?.(target.terminalId)
    )
        throw new CaxriError(
            'CONFLICT',
            'Handed-over Agent Chat is starting or stopping; retry shortly',
        );
    return target;
}

/**
 * `handoverTarget` again, with the input epoch read in the same synchronous step. `create` calls it after its last
 * await before the record exists: a message or keystroke during `verifyLaunch` took the Session back, and any later one
 * must trip the continuation's fence.
 */
export function handoverAdmission(...request: HandoverRequest): HandoverAdmission {
    const target = handoverTarget(...request);
    return { target, inputEpoch: request[0].inputEpoch?.(target.terminalId) };
}

/**
 * Delivers a hand-over's pointer to its live, idle Chat as the next message instead of restarting the provider. The
 * Chat's send chain admits it only against `launchId`, and the input-epoch check here (synchronous with the write)
 * fences human input that arrived since the hand-over was admitted, as the relaunch fence does for a PTY.
 */
function continueLiveChat(
    host: ExactResumeHost,
    record: StoredAgentDelegation,
    launch: { terminalId: string; launchId: string; inputEpoch: number | undefined },
    pointer: string,
): AgentDelegationReceipt {
    const { options } = host;
    const id = record.receipt.delegationId;
    const { terminalId, launchId, inputEpoch } = launch;
    if (options.inputEpoch?.(terminalId) !== inputEpoch) host.fail(id, 'human_input');
    else if (host.isDeleting(record.input.sessionId)) host.fail(id, 'target_changed');
    else {
        host.save({
            ...record,
            launchId,
            receipt: { ...record.receipt, status: 'submitting' },
        });
        if (!host.submit(id, terminalId, launchId, pointer)) host.fail(id, 'target_changed');
    }
    return host.owned(id).receipt;
}

/**
 * `--continue-handover`: the Commander's first task in a handed-over Session, continuing the Session's own conversation
 * with the delegation's launch environment, so lifecycle correlation, waits, results, and later follow-ups work as for
 * any Commander task. A PTY Agent, or a Chat whose provider is not live, is resumed exactly; a live Chat takes the
 * pointer as its next message. The task file lives in this delegation's own private directory, which becomes the root
 * of the chain.
 */
export async function continueHandover(
    host: ExactResumeHost,
    record: StoredAgentDelegation,
    authority: DelegationAuthority,
    admission: HandoverAdmission & { handoverId: string },
): Promise<AgentDelegationReceipt> {
    const { options } = host;
    const id = record.receipt.delegationId;
    const { target, inputEpoch } = admission;
    const { terminalId } = target;
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
    const launchId = options.currentLaunchId?.(terminalId);
    if (launchId && options.isChatTerminal?.(terminalId))
        return continueLiveChat(
            host,
            saved,
            { terminalId, launchId, inputEpoch },
            prepared.pointer,
        );
    try {
        return await launchExactResume(host, saved, authority, {
            terminalId,
            providerSessionId: target.providerSessionId,
            inputEpoch,
            pointer: prepared.pointer,
            expectedLaunchId: launchId,
        });
    } catch (error) {
        /**
         * Dispatch refused the resume before it recorded a receipt (for example a Chat that began starting or stopping
         * meanwhile), so nothing reached the conversation: hand the hand-over back so the Commander can retry. Human
         * input since admission took the Session back instead, so it stays consumed.
         */
        if (
            !options.database.getAgentDispatch(id) &&
            options.inputEpoch?.(terminalId) === inputEpoch
        ) {
            host.save({ ...host.owned(id), hasLostTarget: true });
            options.commanderHandovers?.release(admission.handoverId, id);
        }
        throw error;
    }
}
