import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentChatRewindableMessageIds, agentChatRewindTarget } from '@caxri/protocol';

/**
 * "Edit from here" in progress for one Chat: the earlier message the composer replaces, and whether sending also
 * reverts the files the removed turns changed. See `docs/agent-chat.md`.
 */
export interface AgentChatEdit {
    itemId: string;
    restoreFiles: boolean;
    /**
     * The draft the composer held before the message replaced it, put back when the edit is cancelled.
     */
    previousDraft: string;
}

/**
 * Edits per Chat Terminal, so an edit survives the composer unmounting on a tab or Session switch the way its draft
 * does (`agent-chat-drafts.ts`).
 */
const edits = new Map<string, AgentChatEdit>();

export function readAgentChatEdit(terminalId: string): AgentChatEdit | undefined {
    return edits.get(terminalId);
}

export function writeAgentChatEdit(terminalId: string, edit: AgentChatEdit | undefined): void {
    if (edit) edits.set(terminalId, edit);
    else edits.delete(terminalId);
}

type EditSnapshot = Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'turns'>;

/**
 * Whether a message's "Edit from here" action is enabled, and the reason shown on it when it is not.
 */
export function agentChatEditAvailability(
    snapshot: EditSnapshot,
    itemId: string,
): { canEdit: true } | { canEdit: false; reason: string } {
    const item = snapshot.items.find((candidate) => candidate.id === itemId);
    // Images stay on Server Core and never come back to the composer, as with an edited queued message.
    if (item?.type === 'userMessage' && (item.images?.length ?? 0) > 0)
        return { canEdit: false, reason: 'Messages with images cannot be edited' };
    const result = agentChatRewindTarget(snapshot, itemId);
    if ('target' in result) return { canEdit: true };
    if (result.refusal === 'turnRunning')
        return { canEdit: false, reason: 'Stop the running turn to edit from here' };
    return { canEdit: false, reason: 'This message cannot be edited' };
}

/**
 * Whether a message's "Fork from here" action is enabled, and the reason shown on it when it is not. Unlike an edit, a
 * message with images forks: only its text comes back to the new Chat's composer.
 */
export function agentChatForkAvailability(
    snapshot: EditSnapshot,
    itemId: string,
): { canFork: true } | { canFork: false; reason: string } {
    const result = agentChatRewindTarget(snapshot, itemId);
    if ('target' in result) return { canFork: true };
    if (result.refusal === 'turnRunning')
        return { canFork: false, reason: 'Stop the running turn to fork from here' };
    return { canFork: false, reason: 'The conversation cannot fork from this message' };
}

/**
 * How many turns sending the edit removes, counting a turn that is running now, or `undefined` when the message is no
 * longer one the Chat can rewind to (the Chat was reset or restarted onto other history), which ends the edit.
 */
export function agentChatEditRemovedTurns(
    snapshot: EditSnapshot,
    edit: AgentChatEdit,
): number | undefined {
    if (!agentChatRewindableMessageIds(snapshot).has(edit.itemId)) return undefined;
    const item = snapshot.items.find((candidate) => candidate.id === edit.itemId);
    const position = snapshot.turns.findIndex((turn) => turn.id === item?.turnId);
    return snapshot.turns.length - position;
}

/**
 * The edit banner's line.
 */
export function agentChatEditCaption(removedTurns: number): string {
    return removedTurns === 1
        ? 'Editing an earlier message · its turn will be replaced'
        : `Editing an earlier message · ${removedTurns} turns will be replaced`;
}

/**
 * The Send button while editing. A provider rewinds only a settled conversation, so an edit waits for the running turn
 * to end or be stopped.
 */
export function agentChatEditSendAction(
    isTurnRunning: boolean,
    providerName: string,
): { label: string; tooltip: string; placeholder: string } {
    return {
        label: 'Send edit',
        tooltip: isTurnRunning ? 'Stop the running turn to send the edit' : 'Send edit',
        placeholder: `Edit the message for ${providerName}`,
    };
}
