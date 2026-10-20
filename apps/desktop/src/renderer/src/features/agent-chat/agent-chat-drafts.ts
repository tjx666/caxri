import type {
    AgentChatImageInput,
    AgentChatPathReference,
    AgentChatSkillReference,
} from '@caxri/protocol';
import { agentChatDraftWithReturnedMessage } from '@caxri/protocol';
import { notifyListeners } from '@caxri/utils';
import { debounce } from 'es-toolkit';

import { translate } from '../../i18n';
import { readLocalStorageJson, writeLocalStorageJson } from '../../lib/local-storage';
import {
    agentChatAttachmentDatabaseName,
    configureAgentChatComposerWindowForCommander,
    createAgentChatAttachmentPersistence,
    currentAgentChatComposerScope,
    indexedDatabaseAgentChatAttachmentBackend,
} from './agent-chat-attachment-persistence';
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
 *
 * Every window shares one `localStorage`, so the entry is per composer scope (`agentChatComposerScope`), and a write
 * merges only the Chats this window changed (`dirty`) into what storage holds now: writing the whole map read at load
 * would erase drafts another window of the same scope saved since.
 */
const loaded: { scope?: string; drafts?: Map<string, string> } = {};
const dirty = new Set<string>();

const AGENT_CHAT_DRAFTS_STORAGE_KEY_PREFIX = 'caxri.agent-chat.drafts';

/**
 * The `localStorage` entry holding one composer scope's drafts.
 */
export function agentChatDraftsStorageKey(scope: string): string {
    return `${AGENT_CHAT_DRAFTS_STORAGE_KEY_PREFIX}:${scope}`;
}

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

/**
 * Writes the drafts this window changed into its scope's entry as storage holds it now.
 */
function persistDirtyDrafts(): void {
    const { drafts, scope } = loaded;
    if (!drafts || scope === undefined || dirty.size === 0) return;
    const key = agentChatDraftsStorageKey(scope);
    const stored = parsePersistedAgentChatDrafts(readLocalStorageJson(key));
    for (const terminalId of dirty) {
        stored.delete(terminalId);
        const text = drafts.get(terminalId);
        if (text) stored.set(terminalId, text);
    }
    dirty.clear();
    writeLocalStorageJson(key, persistableAgentChatDrafts(stored));
}

function loadedDrafts(): Map<string, string> {
    const scope = currentAgentChatComposerScope();
    if (loaded.drafts && loaded.scope === scope) return loaded.drafts;
    // A Workbench that learned its environment after typing keeps those keystrokes where they were typed.
    persistDirtyDrafts();
    loaded.scope = scope;
    loaded.drafts = parsePersistedAgentChatDrafts(
        readLocalStorageJson(agentChatDraftsStorageKey(scope)),
    );
    return loaded.drafts;
}

const persistDrafts = debounce(persistDirtyDrafts, PERSIST_DELAY_MS);

// oxlint-disable-next-line typescript/no-unnecessary-condition -- absent under Vitest's Node environment
if (typeof window !== 'undefined') {
    // `pagehide` fires when the window closes or reloads, including a quit; `visibilitychange` covers the window being
    // hidden first. Either way the pending keystrokes reach storage before the Renderer can go away.
    window.addEventListener('pagehide', () => persistDrafts.flush());
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') persistDrafts.flush();
    });
}

export interface AgentChatImageAttachment {
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
 * A file or folder from another application (dropped, pasted, or picked) that the message cites by path
 * (`agentChatTextWithPathReferences`), shown as a card beside the images rather than as path text in the draft.
 */
export interface AgentChatPathAttachment extends AgentChatPathReference {
    id: string;
}

/**
 * A product skill picked from the `+` menu that the message asks the Agent to load (`agentChatTextWithPathReferences`),
 * shown as a card beside the files rather than as an instruction in the draft.
 */
export interface AgentChatSkillAttachment {
    id: string;
    skill: string;
}

export type AgentChatAttachment =
    AgentChatImageAttachment | AgentChatPathAttachment | AgentChatSkillAttachment;

export function isAgentChatImageAttachment(
    attachment: AgentChatAttachment,
): attachment is AgentChatImageAttachment {
    return 'image' in attachment;
}

export function isAgentChatPathAttachment(
    attachment: AgentChatAttachment,
): attachment is AgentChatPathAttachment {
    return 'path' in attachment;
}

export function isAgentChatSkillAttachment(
    attachment: AgentChatAttachment,
): attachment is AgentChatSkillAttachment {
    return 'skill' in attachment;
}

/**
 * Unsent images and path cards per Chat Terminal. A few encoded images already approach the whole `localStorage` quota,
 * which the text drafts and the layout share, so they are mirrored to IndexedDB instead
 * (`agent-chat-attachment-persistence.ts`) and read back once per Renderer, on first use; absent under Vitest's Node
 * environment.
 */
const attachments = new Map<string, AgentChatAttachment[]>();
const attachmentPersistence =
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- absent under Vitest's Node environment
    typeof indexedDB === 'undefined'
        ? undefined
        : createAgentChatAttachmentPersistence({
              backend: indexedDatabaseAgentChatAttachmentBackend(() =>
                  agentChatAttachmentDatabaseName(currentAgentChatComposerScope()),
              ),
          });
const attachmentHydration: { started: boolean } = { started: false };

/**
 * Keeps the Agent Commander window's unsent images, text drafts, and "Edit from here" in its own scope (see
 * `AgentChatComposerWindow`). Called from its entry before the first render, before any composer reads its state.
 */
export function configureAgentChatAttachmentsForCommander(): void {
    configureAgentChatComposerWindowForCommander();
}

export function readAgentChatDraft(terminalId: string): string {
    return loadedDrafts().get(terminalId) ?? '';
}

/**
 * Surfaces that render from a Chat's draft (the turn review's pending comment count) and so need to hear every write,
 * whether it came from typing or from another surface.
 */
const draftChangeListeners = new Map<string, Set<() => void>>();

function notifyDraftChange(terminalId: string): void {
    const listeners = draftChangeListeners.get(terminalId);
    if (!listeners) return;
    // One throwing surface cannot stop the others from hearing the write; Desktop mirrors `console.error` into its log.
    notifyListeners(listeners, undefined, (error) =>
        console.error('agentChat.draft listener failed', error),
    );
}

export function writeAgentChatDraft(terminalId: string, text: string): void {
    const current = loadedDrafts();
    if (current.get(terminalId) === text || (!text && !current.has(terminalId))) return;
    current.delete(terminalId);
    if (text) current.set(terminalId, text);
    dirty.add(terminalId);
    persistDrafts();
    notifyDraftChange(terminalId);
}

/**
 * Calls `listener` after each change to a Chat's stored draft. Returns the unsubscribe. Pairs with
 * {@link readAgentChatDraft} as a `useSyncExternalStore` source.
 */
export function subscribeAgentChatDraftChanges(
    terminalId: string,
    listener: () => void,
): () => void {
    let listeners = draftChangeListeners.get(terminalId);
    if (!listeners) {
        listeners = new Set();
        draftChangeListeners.set(terminalId, listeners);
    }
    listeners.add(listener);
    return () => {
        const current = draftChangeListeners.get(terminalId);
        current?.delete(listener);
        if (current?.size === 0) draftChangeListeners.delete(terminalId);
    };
}

/**
 * A change another surface makes to a Chat's draft: the next draft, given the current one.
 */
export type AgentChatDraftUpdate = (draft: string) => string;

/**
 * The mounted composer of each Chat, which applies a draft update from another surface (Add to message, a turn review
 * comment, Paste as Text) to its live draft. A composer reads the stored draft only when it mounts, so writing the
 * store alone would not reach one already on screen.
 */
const draftUpdateListeners = new Map<string, (update: AgentChatDraftUpdate) => void>();

/**
 * Registers the mounted composer of `terminalId` to receive {@link updateAgentChatDraft}. Returns the unsubscribe.
 */
export function subscribeAgentChatDraftUpdates(
    terminalId: string,
    listener: (update: AgentChatDraftUpdate) => void,
): () => void {
    draftUpdateListeners.set(terminalId, listener);
    return () => {
        if (draftUpdateListeners.get(terminalId) === listener)
            draftUpdateListeners.delete(terminalId);
    };
}

/**
 * Applies `update` to a Chat's draft from outside its composer: to the composer on screen when it is mounted, otherwise
 * to the stored draft it opens with. The one path every outside writer of a draft takes.
 */
export function updateAgentChatDraft(terminalId: string, update: AgentChatDraftUpdate): void {
    const listener = draftUpdateListeners.get(terminalId);
    if (listener) listener(update);
    else writeAgentChatDraft(terminalId, update(readAgentChatDraft(terminalId)));
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
    updateAgentChatDraft(terminalId, (draft) => draftWithParagraph(draft, text));
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
    hydrateAgentChatAttachments();
    return attachments.get(terminalId) ?? [];
}

export function writeAgentChatAttachments(
    terminalId: string,
    next: readonly AgentChatAttachment[],
): void {
    hydrateAgentChatAttachments();
    if (next.length > 0) attachments.set(terminalId, [...next]);
    else attachments.delete(terminalId);
    attachmentPersistence?.save(terminalId, next);
}

/**
 * Releases the composer state of every Chat outside `chatTerminalIds` within this window's composer scope
 * (`agentChatComposerScope`), never another window's: its unsent images (up to the attachment budget per Chat), in
 * memory and in their persisted copy, and its "Edit from here". Nothing else frees them, so a Chat that was closed,
 * deleted with its Session or Project, or switched to the Terminal surface would hold them until the window reloads.
 * The Workbench calls this whenever the set of Chat Terminals it knows changes.
 *
 * The text draft is deliberately kept: it is bounded and trimmed by recency when persisted (see
 * `MAX_PERSISTED_AGENT_CHAT_DRAFTS`), and dropping it on a transient snapshot gap would lose typed text that should
 * survive a restart. Append listeners need nothing here; a composer removes its own when it unmounts.
 */
export function retainAgentChatComposerState(chatTerminalIds: ReadonlySet<string>): void {
    hydrateAgentChatAttachments();
    for (const terminalId of attachments.keys())
        if (!chatTerminalIds.has(terminalId)) attachments.delete(terminalId);
    attachmentPersistence?.retain(chatTerminalIds);
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
 * Delivers what the composer sends besides a plain message (a slash command, an "Edit from here") with the feedback a
 * message gets: it leaves the composer as soon as it is on its way, and comes back if delivery fails, whose reason the
 * delivery reports itself (`tryCommand`). `deliver` calls `clear` once the user can no longer decline, after any
 * confirmation, so a declined confirmation leaves the composer as it was and has nothing to put back. Resolves whether
 * it was delivered.
 */
export async function didDeliverAgentChatComposerInput({
    clear,
    deliver,
    restore,
}: {
    clear: () => void;
    deliver: (clear: () => void) => Promise<boolean>;
    restore: () => void;
}): Promise<boolean> {
    // An object rather than a `let`: control-flow analysis cannot see the callback set it, and reads it as always false.
    const progress = { isCleared: false };
    const isDelivered = await deliver(() => {
        if (progress.isCleared) return;
        progress.isCleared = true;
        clear();
    });
    if (!isDelivered && progress.isCleared) restore();
    return isDelivered;
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
 * What makes two cards the same: the path a file or folder card cites, or the skill a skill card loads.
 */
function referenceKey(attachment: AgentChatPathAttachment | AgentChatSkillAttachment): string {
    return 'path' in attachment ? `path:${attachment.path}` : `skill:${attachment.skill}`;
}

/**
 * `current` followed by each of `added` whose path or skill is not attached yet.
 */
export function agentChatAttachmentsWithReferences(
    current: readonly AgentChatAttachment[],
    added: ReadonlyArray<AgentChatPathAttachment | AgentChatSkillAttachment>,
): AgentChatAttachment[] {
    const attached = new Set(
        current.flatMap((attachment) =>
            isAgentChatImageAttachment(attachment) ? [] : [referenceKey(attachment)],
        ),
    );
    return [
        ...current,
        ...added.filter((attachment) => {
            const key = referenceKey(attachment);
            if (attached.has(key)) return false;
            attached.add(key);
            return true;
        }),
    ];
}

/**
 * The cards a sent message's references and skills come back as, when the message returns to a composer (a failed send,
 * a queued message taken back, "Edit from here", "Fork from here").
 */
export function agentChatReferenceAttachments(message: {
    references: readonly AgentChatPathReference[];
    skills: readonly AgentChatSkillReference[];
}): Array<AgentChatPathAttachment | AgentChatSkillAttachment> {
    return [
        ...message.skills.map(({ name }) => ({ id: crypto.randomUUID(), skill: name })),
        ...message.references.map(({ isDirectory, path }) => ({
            id: crypto.randomUUID(),
            path,
            isDirectory,
        })),
    ];
}

/**
 * Images whose message failed to send, back ahead of any attached since; one still attached is not added twice.
 */
export function attachmentsWithReturned(
    current: readonly AgentChatAttachment[],
    returned: readonly AgentChatAttachment[],
): AgentChatAttachment[] {
    const currentIds = new Set(current.map((attachment) => attachment.id));
    return [...returned.filter((attachment) => !currentIds.has(attachment.id)), ...current];
}

/**
 * The mounted composer of each Chat, which takes a message whose send failed back into its live draft and attachments.
 * The send cleared the composer at once, so by the time it fails the composer that sent it may have unmounted, or been
 * replaced by one that read the stored draft when it mounted; only the one on screen can merge the message with what
 * the user typed since.
 */
const returnListeners = new Map<
    string,
    (text: string, attachments: readonly AgentChatAttachment[]) => void
>();

/**
 * Registers the mounted composer of `terminalId` to receive {@link returnUnsentAgentChatMessage}. Returns the
 * unsubscribe.
 */
export function subscribeAgentChatUnsentReturns(
    terminalId: string,
    listener: (text: string, attachments: readonly AgentChatAttachment[]) => void,
): () => void {
    returnListeners.set(terminalId, listener);
    return () => {
        if (returnListeners.get(terminalId) === listener) returnListeners.delete(terminalId);
    };
}

/**
 * Puts a message whose send failed back into its Chat's composer, ahead of anything typed or attached since: into the
 * composer on screen when it is mounted, otherwise into the stored draft and attachments it opens with.
 */
export function returnUnsentAgentChatMessage(
    terminalId: string,
    text: string,
    sent: readonly AgentChatAttachment[],
): void {
    const listener = returnListeners.get(terminalId);
    if (listener) {
        listener(text, sent);
        return;
    }
    if (text)
        writeAgentChatDraft(
            terminalId,
            agentChatDraftWithReturnedMessage(readAgentChatDraft(terminalId), text),
        );
    writeAgentChatAttachments(
        terminalId,
        attachmentsWithReturned(readAgentChatAttachments(terminalId), sent),
    );
}

/**
 * Restores the images an earlier run left unsent, once. A Chat's composer already on screen takes them the way it takes
 * a failed send's images back (`returnUnsentAgentChatMessage`); any other Chat finds them when its composer mounts.
 */
function hydrateAgentChatAttachments(): void {
    if (!attachmentPersistence || attachmentHydration.started) return;
    attachmentHydration.started = true;
    // eslint-disable-next-line no-void -- hydrate swallows storage failures; an unreadable store restores nothing
    void attachmentPersistence.hydrate().then((restored) => {
        for (const [terminalId, list] of restored) {
            if (returnListeners.has(terminalId)) returnUnsentAgentChatMessage(terminalId, '', list);
            else if (!attachments.has(terminalId)) attachments.set(terminalId, list);
        }
    });
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
    attachment: Pick<AgentChatImageAttachment, 'name'>,
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
    attachment: Pick<AgentChatImageAttachment, 'isResized' | 'name'>,
    index: number,
): string {
    const label = agentChatAttachmentName(attachment, index);
    return attachment.isResized ? agentChatResizedImageLabel(label) : label;
}
