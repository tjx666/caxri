import type {
    AgentChatRequest,
    APPROVAL_REQUEST_CHANGED,
    ApprovalCancelReason,
} from '@caxri/protocol';
import { CaxriError, isDelegationActive, MAX_APPROVAL_CWD_CHARS } from '@caxri/protocol';

import type { AgentLifecycleSignal } from '../../agents';
import type { StoredAgentDelegation } from '../../db';
import type { AgentDelegationServiceOptions } from '../service-options';
import type { PathVerdict } from './coverage';
import type { PathState, PendingApproval } from './entry';

export type HeldRequest = Extract<AgentChatRequest, { kind: 'command' | 'fileChange' }>;

export const PATH_REASONS = {
    absent: 'path_missing',
    outside: 'path_outside',
    unproven: 'path_unproven',
} as const;

export function unavailable(): CaxriError {
    return new CaxriError('NOT_FOUND', 'Approval is unavailable');
}

export function conflict(conflictReason?: typeof APPROVAL_REQUEST_CHANGED): CaxriError {
    return new CaxriError(
        'CONFLICT',
        'The request changed before it could be decided',
        conflictReason && { conflictReason },
    );
}

/**
 * The ids of a lifecycle signal and nothing else: never the working directory the provider claimed, which is request
 * content.
 */
export function heldSignalOf(signal: AgentLifecycleSignal): AgentLifecycleSignal {
    const { terminalId, launchId, provider, phase, agentSessionId, agentTurnId, agentToolUseId } =
        signal;
    return {
        terminalId,
        launchId,
        provider,
        phase,
        ...(agentSessionId && { agentSessionId }),
        ...(agentTurnId && { agentTurnId }),
        ...(agentToolUseId && { agentToolUseId }),
    };
}

export function isHeldKind(request: AgentChatRequest | undefined): request is HeldRequest {
    return request?.kind === 'command' || request?.kind === 'fileChange';
}

export function commandText(request: HeldRequest): 'present' | 'absent' | 'unproven' {
    if (request.kind !== 'command') return 'present';
    const { command, cwd } = request;
    if (!command) return 'absent';
    return command.length >= 4096 || (cwd?.length ?? 0) >= MAX_APPROVAL_CWD_CHARS
        ? 'unproven'
        : 'present';
}

export function pathVerdictOf(path: PathState): PathVerdict {
    if (path.state === 'none') return 'inside';
    return path.state === 'pending' ? 'pending' : path.verdict;
}

/**
 * Why an entry no longer matches the task and Chat it was made for, or `undefined` while it still does.
 * `currentBinding` reads the Session's workbench binding, serialized, only when the other checks pass.
 */
export function entryStaleness(
    task: StoredAgentDelegation,
    entry: PendingApproval,
    options: Pick<AgentDelegationServiceOptions, 'currentLaunchId' | 'inputEpoch'>,
    currentBinding: () => string,
): ApprovalCancelReason | undefined {
    if (!isDelegationActive(task.receipt) || task.receipt.status !== 'blocked') return 'task_ended';
    if (task.hasHumanIntervention) return 'taken_over';
    if (
        task.launchId !== entry.childLaunchId ||
        options.currentLaunchId?.(entry.childTerminalId) !== entry.childLaunchId
    )
        return 'child_launch_changed';
    if (task.turnId !== entry.turnId) return 'turn_changed';
    if (options.inputEpoch?.(entry.childTerminalId) !== entry.inputEpoch) return 'taken_over';
    return currentBinding() === entry.binding ? undefined : 'binding_changed';
}
