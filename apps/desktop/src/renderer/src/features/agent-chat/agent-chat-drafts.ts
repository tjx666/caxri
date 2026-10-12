import type { AgentChatImageInput } from '@caxri/protocol';
import { debounce } from 'es-toolkit';

import { translate } from '../../i18n';
import { readLocalStorageJson, writeLocalStorageJson } from '../../lib/local-storage';
import type { AgentChatEdit } from './agent-chat-edit';
import { readAgentChatEdit, retainAgentChatEdits, writeAgentChatEdit } from './agent-chat-edit';
import { agentChatResizedImageLabel } from './agent-chat-images';

/**
 * Unsent composer text per Chat Terminal. Switching tabs or Sessions unmounts a Chat's composer, and the draft must
 * survive that the way a Terminal's typed-but-unsent line does; it also survives quitting Caxri, so it is mirrored to
 * device-local `localStorage` (the same choice t3code makes for its composer drafts). A draft is never written through
 * to Server Core: it is this device's unsent input, not Session state, which is exactly what `lib/local-storage` is
 * for. Plain maps rather than a store: nothing renders from them, and they hold the user's own message, which stays out
 * of the `__caxriStores` debugging snapshot.
 *
 * Loaded lazily on first use so module load never touches storage, and kept in recency order (a write moves the draft
 * to the end) so trimming drops the drafts left alone longest, typically those of Chats that no longer exist.
 */
const loaded: { drafts?: Map<string, string> } = {};

export const AGENT_CHAT_DRAFTS_STORAGE_KEY = 'caxri.agent-chat.drafts';

/**
 * Bounds on what is persisted, newest first. A Chat that is deleted never clears its draft, and one draft may be as
 * long as a message (100,000 characters), so without a bound the entry grows until `localStorage` refuses every write.
 */
export const MAX_PERSISTED_AGENT_CHAT_DRAFTS = 50;
export const MAX_PERSISTED_AGENT_CHAT_DRAFT_CHARACTERS = 1_000_000;

/**
 * Typing writes the draft on every keystroke; storage is written once the typing pauses, and right away when the window
 * is hidden or closed, so a quit loses at most this window of keystrokes.
 */
const PERSIST_DELAY_MS = 300;

/**
 * Reads the persisted entry, oldest first. Anything malformed is dropped rather than trusted: the entry is written only
 * by this module, but a hand-edited or corrupt profile must not break the composer.
 */
export function parsePersistedAgentChatDrafts(value: unknown): Map<string, string> {
    const parsed = new Map<string, string>();
    if (!Array.isArray(value)) return parsed;
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [terminalId, text] = entry as unknown[];
        if (typeof terminalId === 'string' && typeof text === 'string' && terminalId && text)
            parsed.set(terminalId, text);
    }
    return parsed;
}

/**
 * The entries to persist, oldest first: the newest drafts that fit both bounds. A single draft is never cut, since a
 * partial message restored later would read as the user's own text.
 */
export function persistableAgentChatDrafts(
    current: ReadonlyMap<string, string>,
): Array<[string, string]> {
    const kept: Array<[string, string]> = [];
    let characters = 0;
    for (const entry of [...current].toReversed()) {
        if (kept.length >= MAX_PERSISTED_AGENT_CHAT_DRAFTS) break;
        characters += entry[1].length;
        if (characters > MAX_PERSISTED_AGENT_CHAT_DRAFT_CHARACTERS) break;
        kept.push(entry);
    }
    return kept.toReversed();
}

function loadedDrafts(): Map<string, string> {
    loaded.drafts ??= parsePersistedAgentChatDrafts(
        readLocalStorageJson(AGENT_CHAT_DRAFTS_STORAGE_KEY),
    );
    return loaded.drafts;
}

const persistDrafts = debounce(() => {
    if (loaded.drafts)
        writeLocalStorageJson(
            AGENT_CHAT_DRAFTS_STORAGE_KEY,
            persistableAgentChatDrafts(loaded.drafts),
        );
}, PERSIST_DELAY_MS);

// oxlint-disable-next-line typescript/no-unnecessary-condition -- absent under Vitest's Node environment
if (typeof window !== 'undefined') {
    // `pagehide` fires when the window closes or reloads, including a quit; `visibilitychange` covers the window being
    // hidden first. Either way the pending keystrokes reach storage before the Renderer can go away.
    window.addEventListener('pagehide', () => persistDrafts.flush());
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') persistDrafts.flush();
    });
}

export interface AgentChatAttachment {
    /**
     * Composer-local key, so removing one of two identical images removes the right chip.
     */
    id: string;
    image: AgentChatImageInput;
    /**
     * The picked or dropped file's name, for the chip's alt text. A pasted screenshot often has only a generic name
     * (`image.png`); an empty one falls back to the chip's position.
     */
    name?: string;
    /**
     * The file was larger than the provider's image limit and was resized under it, so the chip says the sent image is
     * not the original.
     */
    isResized?: boolean;
}

/**
 * Unsent images per Chat Terminal. Unlike the text they live for this Renderer only: a few encoded images already
 * approach the whole `localStorage` quota, which the text drafts and the layout share.
 */
const attachments = new Map<string, AgentChatAttachment[]>();

export function readAgentChatDraft(terminalId: string): string {
    return loadedDrafts().get(terminalId) ?? '';
}

export function writeAgentChatDraft(terminalId: string, text: string): void {
    const current = loadedDrafts();
    if (current.get(terminalId) === text || (!text && !current.has(terminalId))) return;
    current.delete(terminalId);
    if (text) current.set(terminalId, text);
    persistDrafts();
}

/**
 * The mounted composer of each Chat, which takes an appended text into its live draft. A composer reads the stored
 * draft only when it mounts, so writing the store alone would not reach one already on screen.
 */
const appendListeners = new Map<string, (text: string) => void>();

/**
 * Registers the mounted composer of `terminalId` to receive {@link appendToAgentChatDraft}. Returns the unsubscribe.
 */
export function subscribeAgentChatDraftAppends(
    terminalId: string,
    listener: (text: string) => void,
): () => void {
    appendListeners.set(terminalId, listener);
    return () => {
        if (appendListeners.get(terminalId) === listener) appendListeners.delete(terminalId);
    };
}

/**
 * `text` as a new paragraph after the draft, or the whole draft when it is empty.
 */
export function draftWithParagraph(draft: string, text: string): string {
    const kept = draft.trimEnd();
    return kept ? `${kept}\n\n${text}` : text;
}

/**
 * Adds `text` to the end of a Chat's draft without sending it: into the composer on screen when it is mounted,
 * otherwise into the stored draft it opens with. During "Edit from here" the draft is the edited message, which Cancel
 * discards, so the edit also records `text` for Cancel to put back (`draftAfterEditCancel`).
 */
export function appendToAgentChatDraft(terminalId: string, text: string): void {
    const edit = readAgentChatEdit(terminalId);
    if (edit)
        writeAgentChatEdit(terminalId, {
            ...edit,
            appendedDraft: draftWithParagraph(edit.appendedDraft, text),
        });
    const listener = appendListeners.get(terminalId);
    if (listener) listener(text);
    else writeAgentChatDraft(terminalId, draftWithParagraph(readAgentChatDraft(terminalId), text));
}

/**
 * The draft an "Edit from here" leaves behind when its edited message is discarded unsent (Cancel, or editing another
 * message instead): the draft set aside when it began, followed by anything appended to the Chat's message meanwhile,
 * such as a turn review comment, which would otherwise be lost with the edited text.
 */
export function draftAfterEditCancel(
    edit: Pick<AgentChatEdit, 'appendedDraft' | 'previousDraft'>,
): string {
    return edit.appendedDraft
        ? draftWithParagraph(edit.previousDraft, edit.appendedDraft)
        : edit.previousDraft;
}

export function readAgentChatAttachments(terminalId: string): AgentChatAttachment[] {
    return attachments.get(terminalId) ?? [];
}

export function writeAgentChatAttachments(
    terminalId: string,
    next: readonly AgentChatAttachment[],
): void {
    if (next.length > 0) attachments.set(terminalId, [...next]);
    else attachments.delete(terminalId);
}

/**
 * Releases the Renderer-only composer state of every Chat outside `chatTerminalIds`: its unsent images (up to the
 * attachment budget per Chat) and its "Edit from here". Nothing else frees them, so a Chat that was closed, deleted
 * with its Session or Project, or switched to the Terminal surface would hold them until the window reloads. The
 * Workbench calls this whenever the set of Chat Terminals it knows changes.
 *
 * The text draft is deliberately kept: it is bounded and trimmed by recency when persisted (see
 * `MAX_PERSISTED_AGENT_CHAT_DRAFTS`), and dropping it on a transient snapshot gap would lose typed text that should
 * survive a restart. Append listeners need nothing here; a composer removes its own when it unmounts.
 */
export function retainAgentChatComposerState(chatTerminalIds: ReadonlySet<string>): void {
    for (const terminalId of attachments.keys())
        if (!chatTerminalIds.has(terminalId)) attachments.delete(terminalId);
    retainAgentChatEdits(chatTerminalIds);
}

/**
 * The text left after a send was acknowledged. Typing continues while the send is in flight (a starting provider makes
 * that window long), so only the exact text that was sent is cleared; anything typed since stays.
 */
export function draftAfterSend(current: string, sent: string): string {
    return current === sent ? '' : current;
}

/**
 * The attachments left after a send was acknowledged: the ones sent are removed, any added since stay.
 */
export function attachmentsAfterSend(
    current: readonly AgentChatAttachment[],
    sent: readonly AgentChatAttachment[],
): AgentChatAttachment[] {
    const sentIds = new Set(sent.map((attachment) => attachment.id));
    return current.filter((attachment) => !sentIds.has(attachment.id));
}

/**
 * Inserts `text` over the selection `[start, end)`, padded with a space wherever it would otherwise run into a
 * neighboring word, and always followed by one so the user can keep typing. A multi-line `text` (a long paste's
 * reference) is a block of its own, so it is padded with line breaks instead. Returns the new draft and where the caret
 * goes.
 */
export function draftWithInsertion(
    draft: string,
    start: number,
    end: number,
    text: string,
): { draft: string; caret: number } {
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    const separator = text.includes('\n') ? '\n' : ' ';
    const leading = before && !(separator === ' ' ? /\s$/u : /\n$/u).test(before) ? separator : '';
    const trailing = (separator === ' ' ? /^\s/u : /^\n/u).test(after) ? '' : separator;
    const inserted = `${leading}${text}${trailing}`;
    return { draft: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}

/**
 * What the composer calls one attachment everywhere (its alt text, Preview, Remove, and the preview's title): the file
 * name when it has one, otherwise its position.
 */
export function agentChatAttachmentName(
    attachment: Pick<AgentChatAttachment, 'name'>,
    index: number,
): string {
    // A pasted image may carry an empty name, which falls back like a missing one.
    return attachment.name === undefined || attachment.name === ''
        ? translate('agentChat.attachments.fallbackName', { number: index + 1 })
        : attachment.name;
}

/**
 * The chip's alt text: the attachment's name (`agentChatAttachmentName`), noting a resized image.
 */
export function agentChatAttachmentLabel(
    attachment: Pick<AgentChatAttachment, 'isResized' | 'name'>,
    index: number,
): string {
    const label = agentChatAttachmentName(attachment, index);
    return attachment.isResized ? agentChatResizedImageLabel(label) : label;
}
