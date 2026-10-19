import type {
    AgentChatDelegatedTaskSource,
    AgentChatItem,
    AgentChatPatchOperation,
} from '@caxri/protocol';
import { parseDelegatedTaskPointer } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';

/**
 * The Session whose Agent delegated a task, or Agent Commander when the caller was the Commander's own hidden Session.
 * `undefined` when the record is gone or no Agent Terminal called it.
 */
export function delegatedTaskSource(
    database: Pick<CaxriDatabase, 'agentCommanderRows' | 'agentDelegations' | 'getTerminal'>,
    delegationId: string,
): AgentChatDelegatedTaskSource | undefined {
    const callerTerminalId = database.agentDelegations.get(delegationId)?.receipt.callerTerminalId;
    const sessionId = callerTerminalId && database.getTerminal(callerTerminalId)?.sessionId;
    if (!sessionId) return undefined;
    return sessionId === database.agentCommanderRows()?.sessionId
        ? { kind: 'commander' }
        : { kind: 'session', sessionId };
}

function withDelegatedTask(
    item: AgentChatItem,
    source: (delegationId: string) => AgentChatDelegatedTaskSource | undefined,
): AgentChatItem {
    if (item.type !== 'userMessage' || item.delegatedTask) return item;
    const pointer = parseDelegatedTaskPointer(item.text);
    if (!pointer) return item;
    const from = source(pointer.delegationId);
    return {
        ...item,
        delegatedTask: { delegationId: pointer.delegationId, ...(from && { source: from }) },
    };
}

/**
 * Marks each user message that is a delegated task pointer, live or replayed. No provider knows a message came from
 * another Agent: the pointer reaches it as plain user input, so its history replays it as such. Server Core recognizes
 * its own pointer format instead and names the delegating Session from the delegation record, so a Client can show
 * "Delegated by" rather than a bubble the user never typed.
 */
export function stampDelegatedTasks(
    operations: readonly AgentChatPatchOperation[],
    source: (delegationId: string) => AgentChatDelegatedTaskSource | undefined,
): readonly AgentChatPatchOperation[] {
    let stamped: AgentChatPatchOperation[] | undefined;
    for (const [index, operation] of operations.entries()) {
        if (operation.op !== 'upsertItem') continue;
        const item = withDelegatedTask(operation.item, source);
        if (item === operation.item) continue;
        stamped ??= [...operations];
        stamped[index] = { op: 'upsertItem', item };
    }
    return stamped ?? operations;
}
