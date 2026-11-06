import type { AgentDelegationCreate, AgentDelegationReceipt } from '@caxri/protocol';

import type { StoredAgentDelegation } from '../../db';
import type { DelegationAuthority } from '../admission';
import type { DelegationWorktree } from '../service-options';
import type { DelegationRetryHost } from './service';
import type { RetryAdmission } from './support';
import { RetryRefused } from './support';

/**
 * The creation input of a fresh retry. A switch to another Agent (`retryProvider`) names only that provider, so the
 * successor launches with the target's current delegation settings; the failed task's model, effort, and preset belong
 * to the Agent it ran on and do not carry over. A type always carries over: it is the task's role, and its private
 * instructions and relation come back with it.
 */
function freshRetryInput(failed: StoredAgentDelegation): Omit<AgentDelegationCreate, 'sessionId'> {
    const { selection } = failed.receipt;
    const base = {
        projectId: failed.input.projectId,
        prompt: failed.input.prompt,
        callerProvider: failed.input.callerProvider,
    };
    const launch = failed.retryProvider
        ? { provider: failed.retryProvider }
        : selection?.preset
          ? { preset: selection.preset }
          : {
                provider: failed.receipt.provider,
                model: selection?.model,
                effort: selection?.effort,
            };
    return {
        ...base,
        ...launch,
        ...(selection?.type && { type: selection.type }),
        ...(failed.input.surface && { surface: failed.input.surface }),
        ...(failed.input.handoff && { handoff: true as const }),
        ...(failed.input.consult && { consult: true as const }),
        ...(failed.input.independent && { independent: true as const }),
    };
}

/**
 * A new Session on the failed task's workbench root: it carries the failed Session's title and creator, and binds the
 * linked worktree the failed Session used instead of making a second branch. The failed Session stays as it is.
 */
export async function startFreshRetry(
    host: DelegationRetryHost,
    failed: StoredAgentDelegation,
    retryId: string,
    authority: DelegationAuthority,
    retry: RetryAdmission,
    worktree: DelegationWorktree | undefined,
): Promise<AgentDelegationReceipt> {
    const { newSessions, database } = host.options;
    const session = database.getSession(failed.receipt.sessionId);
    if (!newSessions || !session) throw new RetryRefused('not_retryable');
    const sessionId = newSessions.create(
        failed.input.projectId,
        session.title,
        false,
        session.createdBySessionId,
        session.createdBySessionId ? session.createdByRelation : undefined,
        worktree,
    );
    try {
        return await host.admit(
            retryId,
            authority,
            { ...freshRetryInput(failed), sessionId },
            true,
            retry,
        );
    } catch (error) {
        if (database.agentDelegations.get(retryId)?.input.sessionId !== sessionId)
            newSessions.discard(sessionId);
        throw error;
    }
}
