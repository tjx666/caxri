import type {
    AgentChatDelegatedTask,
    AgentChatDelegatedTaskSource,
    AgentChatItem,
    AgentChatPatchOperation,
} from '@caxri/protocol';
import { parseDelegatedRedirect, parseDelegatedTaskPointer } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import { chatTextDigest } from './chat-turn-answer';

/**
 * What the delegation record tells about a delegated task besides its ID.
 */
export type DelegatedTaskDetails = Omit<AgentChatDelegatedTask, 'delegationId'>;

/**
 * A redirect message found in the Chat: the operation it names and the direction it carries.
 */
export interface DelegatedRedirect {
    operationId: string;
    text: string;
}

/**
 * The task the caller wrote, and who called: the Session whose Agent delegated it, or Caxri Bot when the caller was
 * Caxri Bot's own hidden Session. The source is absent when no Agent Terminal called it; both are absent when the
 * record is gone. A follow-up or resume has its own record, so its pointer reads as its own task rather than the first.
 * A task the caller handed off with `/new-session` says so (`handoff`).
 */
export function delegatedTaskDetails(
    database: Pick<CaxriDatabase, 'caxriBotRows' | 'agentDelegations' | 'getTerminal'>,
    delegationId: string,
    redirect?: DelegatedRedirect,
): DelegatedTaskDetails {
    const record = database.agentDelegations.get(delegationId);
    if (!record) return {};
    /**
     * A redirect is recognized only when the task recorded this operation with this exact text, so a person who types
     * the envelope into the Chat does not get a "delegated" message.
     */
    const claim =
        redirect &&
        record.redirects?.find(({ operationId }) => operationId === redirect.operationId);
    if (redirect && claim?.digest !== chatTextDigest(redirect.text)) return {};
    const { callerTerminalId } = record.receipt;
    const sessionId = callerTerminalId && database.getTerminal(callerTerminalId)?.sessionId;
    const source: AgentChatDelegatedTaskSource | undefined = sessionId
        ? sessionId === database.caxriBotRows()?.sessionId
            ? { kind: 'bot' }
            : { kind: 'session', sessionId }
        : undefined;
    return {
        prompt: redirect ? redirect.text : record.input.prompt,
        ...(source && { source }),
        ...(redirect ? { redirect: true as const } : record.input.handoff && { handoff: true }),
    };
}

function withDelegatedTask(
    item: AgentChatItem,
    details: (delegationId: string, redirect?: DelegatedRedirect) => DelegatedTaskDetails,
): AgentChatItem {
    if (item.type !== 'userMessage' || item.delegatedTask) return item;
    const redirect = parseDelegatedRedirect(item.text);
    if (redirect) {
        const task = details(redirect.delegationId, redirect);
        return task.redirect
            ? { ...item, delegatedTask: { delegationId: redirect.delegationId, ...task } }
            : item;
    }
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
    details: (delegationId: string, redirect?: DelegatedRedirect) => DelegatedTaskDetails,
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
