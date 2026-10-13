import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentChatRewindableMessageIds, agentChatRewindTarget } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { readLocalStorageJson, writeLocalStorageJson } from '../../lib/local-storage';
import { currentAgentChatComposerScope } from './agent-chat-attachment-persistence';

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

const AGENT_CHAT_EDITS_STORAGE_KEY_PREFIX = 'caxri.agent-chat.edits';

/**
 * The `localStorage` entry holding one composer scope's edits (`agentChatComposerScope`). Every window shares one
 * `localStorage`, and each retains only its own Chats, so one shared entry let a Workbench delete the Commander's or
 * another environment's edits.
 */
export function agentChatEditsStorageKey(scope: string): string {
    return `${AGENT_CHAT_EDITS_STORAGE_KEY_PREFIX}:${scope}`;
}

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
 * as that text with the held-back draft lost and Enter sending it as a new message. Loaded lazily per composer scope,
 * in recency order.
 */
const loaded: { current?: { scope: string; edits: Map<string, AgentChatEdit> } } = {};

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
        const { itemId, restoreFiles, previousDraft, appendedDraft } = edit as Record<
            string,
            unknown
        >;
        if (
            typeof itemId === 'string' &&
            itemId &&
            typeof restoreFiles === 'boolean' &&
            typeof previousDraft === 'string' &&
            typeof appendedDraft === 'string'
        )
            parsed.set(terminalId, { itemId, restoreFiles, previousDraft, appendedDraft });
    }
    return parsed;
}

/**
 * The entries to persist, oldest first: the newest edits whose held-back drafts and appended comments fit both bounds.
 */
export function persistableAgentChatEdits(
    current: ReadonlyMap<string, AgentChatEdit>,
): Array<[string, AgentChatEdit]> {
    const kept: Array<[string, AgentChatEdit]> = [];
    let characters = 0;
    for (const entry of [...current].toReversed()) {
        if (kept.length >= MAX_PERSISTED_AGENT_CHAT_EDITS) break;
        characters += entry[1].previousDraft.length + entry[1].appendedDraft.length;
        if (characters > MAX_PERSISTED_AGENT_CHAT_EDIT_CHARACTERS) break;
        kept.push(entry);
    }
    return kept.toReversed();
}

function loadedScope(): { scope: string; edits: Map<string, AgentChatEdit> } {
    const scope = currentAgentChatComposerScope();
    if (loaded.current?.scope !== scope)
        loaded.current = {
            scope,
            edits: parsePersistedAgentChatEdits(
                readLocalStorageJson(agentChatEditsStorageKey(scope)),
            ),
        };
    return loaded.current;
}

function loadedEdits(): Map<string, AgentChatEdit> {
    return loadedScope().edits;
}

/**
 * Writes this window's edits of `terminalIds` (an absent one is removed) into its scope's entry as storage holds it
 * now, so another window of the same scope keeps the edits it saved since this one loaded.
 */
function persistEdits(terminalIds: Iterable<string>): void {
    const { edits, scope } = loadedScope();
    const key = agentChatEditsStorageKey(scope);
    const stored = parsePersistedAgentChatEdits(readLocalStorageJson(key));
    for (const terminalId of terminalIds) {
        stored.delete(terminalId);
        const edit = edits.get(terminalId);
        if (edit) stored.set(terminalId, edit);
    }
    writeLocalStorageJson(key, persistableAgentChatEdits(stored));
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
    persistEdits([terminalId]);
}

/**
 * Drops the edit of every Chat outside `chatTerminalIds` within this window's composer scope only; other windows'
 * scopes are never touched. Called through `retainAgentChatComposerState`.
 */
export function retainAgentChatEdits(chatTerminalIds: ReadonlySet<string>): void {
    const edits = loadedEdits();
    const retired = edits
        .keys()
        .filter((terminalId) => !chatTerminalIds.has(terminalId))
        .toArray();
    if (retired.length === 0) return;
    for (const terminalId of retired) edits.delete(terminalId);
    persistEdits(retired);
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
        return { canEdit: false, reason: translate('agentChat.edit.imagesUnsupported') };
    const result = agentChatRewindTarget(snapshot, itemId);
    if ('target' in result) return { canEdit: true };
    if (result.refusal === 'turnRunning')
        return { canEdit: false, reason: translate('agentChat.edit.stopToEdit') };
    return { canEdit: false, reason: translate('agentChat.edit.cannotEdit') };
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
        return { canFork: false, reason: translate('agentChat.edit.stopToFork') };
    return { canFork: false, reason: translate('agentChat.edit.cannotFork') };
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
        return { reason: translate('agentChat.edit.stopToRestore') };
    return { reason: translate('agentChat.edit.cannotRestore') };
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
        ? translate('agentChat.edit.captionOne')
        : translate('agentChat.edit.captionOther', { count: removedTurns });
}

/**
 * The Send button while editing. A provider rewinds only a settled conversation, so an edit waits for the running turn
 * to end or be stopped.
 */
export function agentChatEditSendAction(
    isTurnRunning: boolean,
    providerName: string,
    t: Translate = translate,
): { label: string; tooltip: string; placeholder: string } {
    return {
        label: t('agentChat.edit.send'),
        tooltip: t(isTurnRunning ? 'agentChat.edit.stopToSend' : 'agentChat.edit.send'),
        placeholder: t('agentChat.edit.placeholder', { provider: providerName }),
    };
}
