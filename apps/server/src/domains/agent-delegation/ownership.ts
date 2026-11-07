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
 * Whether `terminalId` still runs the conversation that created `record`: its Agent resumed that same provider
 * conversation (a Caxri restart, an idle suspension, a relaunch), so it remembers the task even though it is a new
 * Endpoint generation. A new conversation or another provider in the same Terminal changes the binding and fails.
 */
export function isSameCallerConversation(
    database: CaxriDatabase,
    record: Pick<StoredAgentDelegation, 'callerConversationId'>,
    terminalId: string | undefined,
): boolean {
    const conversationId = record.callerConversationId;
    return Boolean(
        conversationId &&
        terminalId &&
        database.getTerminal(terminalId)?.agentSessionId === conversationId,
    );
}

/**
 * A task belongs to the Terminal and conversation that created it. The exact Endpoint generation qualifies, and so does
 * a later generation that resumed the same conversation, so an Agent restarted mid-work can still read, follow up, and
 * stop what it started. An Agent with a new conversation in that Terminal remembers none of it and is refused, so it
 * cannot settle work it knows nothing about. Caxri Bot keeps its whole ledger across generations of its system
 * Terminal. The owner's own clients see every task.
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
            (authority.principal.kind === 'agent' &&
                isSameCallerConversation(database, record, authority.callerTerminalId)) ||
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
