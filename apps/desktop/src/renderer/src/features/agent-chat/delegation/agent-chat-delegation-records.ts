import type { AgentChatCommandDelegation, AgentChatItem, AgentChatWorkItem } from '@caxri/protocol';

const NO_DELEGATIONS: readonly AgentChatCommandDelegation[] = [];

/**
 * The delegations a command item recorded, or none. Server Core stamps them from the delegation records of this Chat's
 * own Terminal, so every entry names a real task.
 */
export function delegationRecordsOf(
    item: AgentChatItem | AgentChatWorkItem,
): readonly AgentChatCommandDelegation[] {
    return item.type === 'command' && item.delegations ? item.delegations : NO_DELEGATIONS;
}

/**
 * Whether the item is a command that created delegations. The Desktop timeline keeps such a command in view when its
 * turn folds (`foldAgentChatTurn`'s `isAlsoKept`) and draws it as record rows in place of an ordinary command row.
 */
export function isDelegationRecordItem(item: AgentChatItem | AgentChatWorkItem): boolean {
    return delegationRecordsOf(item).length > 0;
}
