import type { AgentDelegationReceipt } from '@caxri/protocol';
import { isDelegationActive } from '@caxri/protocol';

import type { CaxriDatabase, StoredAgentDelegation } from '../db';
import type { DelegationAuthority } from './admission';
import { isCaxriBotCaller, isSamePrincipal } from './admission';

/**
 * Whether a principal reads every task: all kinds except an Agent and a delegation client, which are held to the tasks
 * they created. The one place that kind test lives, shared by task reads and history reads.
 */
export function isDelegationOwnerPrincipal(principal: DelegationAuthority['principal']): boolean {
    return principal.kind !== 'agent' && principal.kind !== 'delegation-client';
}

/**
 * A task belongs to the exact Endpoint generation that created it, so a relaunched Agent cannot settle work its
 * predecessor started. Caxri Bot is the exception: a Caxri restart or Codex relaunch starts a new generation of the
 * same system Terminal, and its ledger of earlier tasks must keep resolving. The owner's own clients see every task.
 */
export function isDelegationOwner(
    database: CaxriDatabase,
    record: StoredAgentDelegation,
    authority: DelegationAuthority,
): boolean {
    if (isDelegationOwnerPrincipal(authority.principal)) return true;
    return (
        authority.callerTerminalId === record.receipt.callerTerminalId &&
        (isSamePrincipal(authority.principal, record.principal) ||
            isCaxriBotCaller(database, authority))
    );
}

/**
 * The caller's own tasks, newest first, under the same ownership rule as `status`, so an Agent that lost its context
 * can recover the IDs it started.
 */
export function listOwnedDelegations(
    database: CaxriDatabase,
    authority: DelegationAuthority,
    options: { active: boolean; limit: number },
): { delegations: AgentDelegationReceipt[]; truncated: boolean } {
    const owned = database.agentDelegations
        .all()
        .filter(
            (record) =>
                isDelegationOwner(database, record, authority) &&
                (!options.active || isDelegationActive(record.receipt)),
        )
        .map((record) => record.receipt)
        .toSorted((a, b) => b.createdAt - a.createdAt);
    return { delegations: owned.slice(0, options.limit), truncated: owned.length > options.limit };
}
