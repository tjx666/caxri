import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentChatRewindableMessageIds, agentChatRewindTarget } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../../i18n';
import { agentChatComposerState } from '../composer-input/device-state/agent-chat-composer-state';

/**
 * "Edit from here" in progress for one Chat: the earlier message the composer replaces, and whether sending also
 * reverts the files the removed turns changed. See `docs/agent-chat.md`.
 */
export interface AgentChatEdit {
    itemId: string;
    restoreFiles: boolean;
    /**
     * The draft the composer held before the message replaced it, put back when the edit is cancelled or sent.
     */
    previousDraft: string;
    /**
     * Text another surface appended to the Chat's message during the edit (a turn review comment), as paragraphs, empty
     * when none was. It lands in the edited message too, so a sent edit carries it; Cancel discards the edited message,
     * so it puts this back after `previousDraft` (`draftAfterEditCancel`) instead of silently dropping it.
     */
    appendedDraft: string;
}

/**
 * Edits per Chat Terminal, so an edit survives the composer unmounting on a tab or Session switch the way its draft
 * does (`agent-chat-drafts.ts`). They are mirrored to the device store too (`agent-chat-composer-state.ts`): the draft
 * already survives a restart, and starting an edit replaced it with the earlier message's text, so an edit kept only in
 * memory came back as that text with the held-back draft lost and Enter sending it as a new message.
 */
export function readAgentChatEdit(terminalId: string): AgentChatEdit | undefined {
    return agentChatComposerState.edits().get(terminalId);
}

/**
 * Stores or ends a Chat's edit, written through to storage at once: an edit starts and ends on a click, never per
 * keystroke, so there is nothing to debounce.
 */
export function writeAgentChatEdit(terminalId: string, edit: AgentChatEdit | undefined): void {
    const edits = agentChatComposerState.edits();
    if (!edit && !edits.has(terminalId)) return;
    edits.delete(terminalId);
    if (edit) edits.set(terminalId, edit);
    agentChatComposerState.saveEdit(terminalId, edit);
}

type EditSnapshot = Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'turns'>;

/**
 * Whether a message's "Edit from here" action is enabled, and the reason shown on it when it is not. The reason is a
 * translation key rather than text: the availability table is cached by its serialized form, so a string would keep its
 * language after a runtime language switch. Consumers translate it with their own `t`.
 */
export function agentChatEditAvailability(
    snapshot: EditSnapshot,
    itemId: string,
): { canEdit: true } | { canEdit: false; reason: TranslationKey } {
    const item = snapshot.items.find((candidate) => candidate.id === itemId);
    // Images stay on Server Core and never come back to the composer, as with an edited queued message.
    if (item?.type === 'userMessage' && (item.images?.length ?? 0) > 0)
        return { canEdit: false, reason: 'agentChat.edit.imagesUnsupported' };
    const result = agentChatRewindTarget(snapshot, itemId);
    if ('target' in result) return { canEdit: true };
    if (result.refusal === 'turnRunning')
        return { canEdit: false, reason: 'agentChat.edit.stopToEdit' };
    return { canEdit: false, reason: 'agentChat.edit.cannotEdit' };
}

/**
 * Whether a message's "Fork from here" action is enabled, and the reason shown on it when it is not. Unlike an edit, a
 * message with images forks: only its text comes back to the new Chat's composer.
 */
export function agentChatForkAvailability(
    snapshot: EditSnapshot,
    itemId: string,
): { canFork: true } | { canFork: false; reason: TranslationKey } {
    const result = agentChatRewindTarget(snapshot, itemId);
    if ('target' in result) return { canFork: true };
    if (result.refusal === 'turnRunning')
        return { canFork: false, reason: 'agentChat.edit.stopToFork' };
    return { canFork: false, reason: 'agentChat.edit.cannotFork' };
}

/**
 * Whether a message's "Restore code to here" action is enabled: the turns whose file changes it undoes, or the reason
 * shown on it when it is not. Unlike an edit, a message with images can restore code, since nothing returns to the
 * composer.
 */
export function agentChatRestoreAvailability(
    snapshot: EditSnapshot,
    itemId: string,
): { restoredTurns: number } | { reason: TranslationKey } {
    const result = agentChatRewindTarget(snapshot, itemId);
    if ('target' in result) return { restoredTurns: result.target.removedTurns };
    if (result.refusal === 'turnRunning') return { reason: 'agentChat.edit.stopToRestore' };
    return { reason: 'agentChat.edit.cannotRestore' };
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
export function agentChatEditCaption(removedTurns: number, t: Translate): string {
    return removedTurns === 1
        ? t('agentChat.edit.captionOne')
        : t('agentChat.edit.captionOther', { count: removedTurns });
}

/**
 * The Send button while editing. A provider rewinds only a settled conversation, so an edit waits for the running turn
 * to end or be stopped.
 */
export function agentChatEditSendAction(
    isTurnRunning: boolean,
    providerName: string,
    t: Translate,
): { label: string; tooltip: string; placeholder: string } {
    return {
        label: t('agentChat.edit.send'),
        tooltip: t(isTurnRunning ? 'agentChat.edit.stopToSend' : 'agentChat.edit.send'),
        placeholder: t('agentChat.edit.placeholder', { provider: providerName }),
    };
}

/**
 * What one rewindable user message offers. `edit` and `fork` are `null` when enabled, otherwise the translation key of
 * the reason they are disabled; `restore` is the number of turns it undoes when enabled, otherwise that key.
 */
export interface AgentChatEditAvailabilityRow {
    edit: TranslationKey | null;
    fork: TranslationKey | null;
    restore: TranslationKey | number;
}

/**
 * Every rewindable message's availability, keyed by item id; a message absent from the table offers no action.
 */
export type AgentChatEditAvailabilityTable = ReadonlyMap<string, AgentChatEditAvailabilityRow>;

/**
 * Computes the availability table and serializes it. The serialized form is the table's identity: a streamed delta
 * leaves every answer unchanged, so the string stays equal and whatever is derived from it
 * ({@link parseAgentChatEditAvailability}) stays referentially stable, which keeps the user messages from re-rendering.
 */
export function serializeAgentChatEditAvailability(
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'turns'>,
): string {
    const rows: Array<[string, AgentChatEditAvailabilityRow]> = [];
    for (const itemId of agentChatRewindableMessageIds(snapshot)) {
        const edit = agentChatEditAvailability(snapshot, itemId);
        const fork = agentChatForkAvailability(snapshot, itemId);
        const restore = agentChatRestoreAvailability(snapshot, itemId);
        rows.push([
            itemId,
            {
                edit: edit.canEdit ? null : edit.reason,
                fork: fork.canFork ? null : fork.reason,
                restore: 'reason' in restore ? restore.reason : restore.restoredTurns,
            },
        ]);
    }
    return JSON.stringify(rows);
}

export function parseAgentChatEditAvailability(serialized: string): AgentChatEditAvailabilityTable {
    return new Map(JSON.parse(serialized) as Array<[string, AgentChatEditAvailabilityRow]>);
}
