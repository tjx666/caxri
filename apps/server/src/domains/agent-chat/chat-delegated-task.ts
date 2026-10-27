import type {
    AgentChatDelegatedTask,
    AgentChatDelegatedTaskSource,
    AgentChatItem,
    AgentChatPatchOperation,
} from '@caxri/protocol';
import { parseDelegatedTaskPointer } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';

/**
 * What the delegation record tells about a delegated task besides its ID.
 */
export type DelegatedTaskDetails = Omit<AgentChatDelegatedTask, 'delegationId'>;

/**
 * The task the caller wrote, and who called: the Session whose Agent delegated it, or Caxri Bot when the caller was
 * Caxri Bot's own hidden Session. The source is absent when no Agent Terminal called it; both are absent when the
 * record is gone. A follow-up or resume has its own record, so its pointer reads as its own task rather than the first.
 * A task the caller handed off with `/new-session` says so (`handoff`).
 */
export function delegatedTaskDetails(
    database: Pick<CaxriDatabase, 'caxriBotRows' | 'agentDelegations' | 'getTerminal'>,
    delegationId: string,
): DelegatedTaskDetails {
    const record = database.agentDelegations.get(delegationId);
    if (!record) return {};
    const { callerTerminalId } = record.receipt;
    const sessionId = callerTerminalId && database.getTerminal(callerTerminalId)?.sessionId;
    const source: AgentChatDelegatedTaskSource | undefined = sessionId
        ? sessionId === database.caxriBotRows()?.sessionId
            ? { kind: 'bot' }
            : { kind: 'session', sessionId }
        : undefined;
    return {
        prompt: record.input.prompt,
        ...(source && { source }),
        ...(record.input.handoff && { handoff: true }),
    };
}

function withDelegatedTask(
    item: AgentChatItem,
    details: (delegationId: string) => DelegatedTaskDetails,
): AgentChatItem {
    if (item.type !== 'userMessage' || item.delegatedTask) return item;
    const pointer = parseDelegatedTaskPointer(item.text);
    if (!pointer) return item;
    return {
        ...item,
        delegatedTask: { delegationId: pointer.delegationId, ...details(pointer.delegationId) },
    };
}

/**
 * Marks each user message that is a delegated task pointer, live or replayed. No provider knows a message came from
 * another Agent: the pointer reaches it as plain user input, so its history replays it as such. Server Core recognizes
 * its own pointer format instead and names the delegating Session and the task from the delegation record, so a Client
 * can show "Delegated by" and what was asked rather than a bubble the user never typed.
 */
export function stampDelegatedTasks(
    operations: readonly AgentChatPatchOperation[],
    details: (delegationId: string) => DelegatedTaskDetails,
): readonly AgentChatPatchOperation[] {
    let stamped: AgentChatPatchOperation[] | undefined;
    for (const [index, operation] of operations.entries()) {
        if (operation.op !== 'upsertItem') continue;
        const item = withDelegatedTask(operation.item, details);
        if (item === operation.item) continue;
        stamped ??= [...operations];
        stamped[index] = { op: 'upsertItem', item };
    }
    return stamped ?? operations;
}
