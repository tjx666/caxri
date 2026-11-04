import type { AgentChatPermissionMode } from '@caxri/protocol';
import { isChatTerminal, isDelegationActive, MAX_DELEGATION_DEPTH } from '@caxri/protocol';

import type { CaxriDatabase, StoredAgentDelegation } from '../../db';
import type { ParentEvidence } from './coverage';

/**
 * One Agent of a delegation chain: the Terminal and exact launch that delegated the previous task, and the state of the
 * task that put it there. Ids and closed values only.
 */
export interface ChainHop {
    terminalId: string;
    launchId: string;
    delegationId?: string;
    taskState: 'intact' | 'taken_over' | 'inactive';
}

interface ChainHost {
    database: Pick<CaxriDatabase, 'agentDelegations'>;
    inputEpoch?(terminalId: string): number;
}

/**
 * Walks from a delegated task up to the root Agent, verifying every hop from stored records and never from the caller.
 * Hop `i` is the Agent that delegated the previous task. A person typing in a middle hop's Terminal marks only the
 * tasks delegated into it, so each hop's own task state is judged here (the same three-way test the follow-up gates
 * use). `lineageProven` is false at the first hop that cannot be tied to the next: a missing ID, a pruned or repeated
 * record, a Terminal or launch that does not match, or a depth that does not step down by one.
 */
export function walkChain(
    host: ChainHost,
    child: StoredAgentDelegation,
): { lineageProven: boolean; hops: ChainHop[] } {
    const hops: ChainHop[] = [];
    const seen = new Set([child.receipt.delegationId]);
    let task = child;
    for (let step = 0; step < MAX_DELEGATION_DEPTH; step++) {
        const terminalId = task.receipt.callerTerminalId;
        const launchId = task.callerLaunchId;
        if (!terminalId || !launchId) return { lineageProven: false, hops };
        const parentId = task.receipt.parentDelegationId;
        if (!parentId) {
            hops.push({ terminalId, launchId, taskState: 'intact' });
            return { lineageProven: true, hops };
        }
        const parent = host.database.agentDelegations.get(parentId);
        if (
            !parent ||
            seen.has(parentId) ||
            parent.receipt.terminalId !== terminalId ||
            parent.launchId !== launchId ||
            parent.receipt.depth !== (task.receipt.depth ?? 1) - 1
        )
            return { lineageProven: false, hops };
        // A person's input ends the hop's task as `human_intervened`, which is no longer active: judge the takeover
        // first so it keeps its own reason instead of reading as a settled task.
        const taskState =
            parent.hasHumanIntervention || parent.receipt.status === 'human_intervened'
                ? 'taken_over'
                : !isDelegationActive(parent.receipt)
                  ? 'inactive'
                  : parent.inputEpoch === undefined ||
                      host.inputEpoch?.(terminalId) !== parent.inputEpoch
                    ? 'taken_over'
                    : 'intact';
        hops.push({ terminalId, launchId, delegationId: parentId, taskState });
        seen.add(parentId);
        task = parent;
    }
    return { lineageProven: false, hops };
}

/**
 * What a delegating Agent's own Chat reports about its permission (see `ChatDelegationLinks.appliedPermission`).
 */
export interface AppliedPermissionRead {
    launchId: string;
    permissionMode?: AgentChatPermissionMode;
    planMode: boolean;
    applied: boolean;
}

interface EvidenceHost {
    database: Pick<CaxriDatabase, 'getTerminal'>;
    currentLaunchId?(terminalId: string): string | undefined;
    appliedPermission(terminalId: string): AppliedPermissionRead | undefined;
}

/**
 * The coverage evidence of one hop, read now. The launch is proven only when the live launch, the hop's recorded
 * launch, and the launch that reported the permission are the same one.
 */
export function hopEvidence(host: EvidenceHost, hop: ChainHop): ParentEvidence {
    const terminal = host.database.getTerminal(hop.terminalId);
    const permission = host.appliedPermission(hop.terminalId);
    const isLaunchProven =
        host.currentLaunchId?.(hop.terminalId) === hop.launchId &&
        permission?.launchId === hop.launchId;
    return {
        surface: terminal && isChatTerminal(terminal) ? 'chat' : 'terminal',
        provider: terminal?.provider,
        launchProven: isLaunchProven,
        taskState: hop.taskState,
        modeUnapplied: permission !== undefined && !permission.applied,
        planMode: permission?.planMode,
        ...(permission?.applied && { mode: permission.permissionMode }),
    };
}
