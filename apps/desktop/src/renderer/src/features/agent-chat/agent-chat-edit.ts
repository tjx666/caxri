import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentChatRewindableMessageIds, agentChatRewindTarget } from '@caxri/protocol';

import { readLocalStorageJson, writeLocalStorageJson } from '../../lib/local-storage';

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

export const AGENT_CHAT_EDITS_STORAGE_KEY = 'caxri.agent-chat.edits';

/**
 * Bounds on what is persisted, newest first, for the same reason as the drafts' bounds: an edit of a deleted Chat is
 * never cleared, and its held-back draft may be as long as a message.
 */
export const MAX_PERSISTED_AGENT_CHAT_EDITS = 50;
export const MAX_PERSISTED_AGENT_CHAT_EDIT_CHARACTERS = 1_000_000;

/**
 * Edits per Chat Terminal, so an edit survives the composer unmounting on a tab or Session switch the way its draft
 * does (`agent-chat-drafts.ts`). They are mirrored to device-local `localStorage` too: the draft already survives a
 * restart, and starting an edit replaced it with the earlier message's text, so an edit kept only in memory came back
 * as that text with the held-back draft lost and Enter sending it as a new message. Loaded lazily, in recency order.
 */
const loaded: { edits?: Map<string, AgentChatEdit> } = {};

/**
 * Reads the persisted entry, oldest first. Anything malformed is dropped rather than trusted.
 */
export function parsePersistedAgentChatEdits(value: unknown): Map<string, AgentChatEdit> {
    const parsed = new Map<string, AgentChatEdit>();
    if (!Array.isArray(value)) return parsed;
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [terminalId, edit] = entry as unknown[];
        if (typeof terminalId !== 'string' || !terminalId || typeof edit !== 'object' || !edit)
            continue;
        const { itemId, restoreFiles, previousDraft } = edit as Record<string, unknown>;
        if (
            typeof itemId === 'string' &&
            itemId &&
            typeof restoreFiles === 'boolean' &&
            typeof previousDraft === 'string'
        )
            parsed.set(terminalId, { itemId, restoreFiles, previousDraft });
    }
    return parsed;
}

/**
 * The entries to persist, oldest first: the newest edits whose held-back drafts fit both bounds.
 */
export function persistableAgentChatEdits(
    current: ReadonlyMap<string, AgentChatEdit>,
): Array<[string, AgentChatEdit]> {
    const kept: Array<[string, AgentChatEdit]> = [];
    let characters = 0;
    for (const entry of [...current].toReversed()) {
        if (kept.length >= MAX_PERSISTED_AGENT_CHAT_EDITS) break;
        characters += entry[1].previousDraft.length;
        if (characters > MAX_PERSISTED_AGENT_CHAT_EDIT_CHARACTERS) break;
        kept.push(entry);
    }
    return kept.toReversed();
}

function loadedEdits(): Map<string, AgentChatEdit> {
    loaded.edits ??= parsePersistedAgentChatEdits(
        readLocalStorageJson(AGENT_CHAT_EDITS_STORAGE_KEY),
    );
    return loaded.edits;
}

export function readAgentChatEdit(terminalId: string): AgentChatEdit | undefined {
    return loadedEdits().get(terminalId);
}

/**
 * Stores or ends a Chat's edit, written through to storage at once: an edit starts and ends on a click, never per
 * keystroke, so there is nothing to debounce.
 */
export function writeAgentChatEdit(terminalId: string, edit: AgentChatEdit | undefined): void {
    const edits = loadedEdits();
    if (!edit && !edits.has(terminalId)) return;
    edits.delete(terminalId);
    if (edit) edits.set(terminalId, edit);
    writeLocalStorageJson(AGENT_CHAT_EDITS_STORAGE_KEY, persistableAgentChatEdits(edits));
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
 * Whether a message's "Restore code to here" action is enabled: the turns whose file changes it undoes, or the reason
 * shown on it when it is not. Unlike an edit, a message with images can restore code, since nothing returns to the
 * composer.
 */
export function agentChatRestoreAvailability(
    snapshot: EditSnapshot,
    itemId: string,
): { restoredTurns: number } | { reason: string } {
    const result = agentChatRewindTarget(snapshot, itemId);
    if ('target' in result) return { restoredTurns: result.target.removedTurns };
    if (result.refusal === 'turnRunning')
        return { reason: 'Stop the running turn to restore code' };
    return { reason: 'Code cannot be restored to this message' };
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
