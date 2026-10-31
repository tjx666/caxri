import type {
    AgentChatImageInput,
    AgentChatPathReference,
    AgentChatSkillReference,
} from '@caxri/protocol';
import { agentChatDraftWithReturnedMessage } from '@caxri/protocol';

import type { AgentChatEdit } from '../composer/agent-chat-edit';
import { readAgentChatEdit, writeAgentChatEdit } from '../composer/agent-chat-edit';
import {
    didDeliverToMountedComposer,
    notifyDraftChange,
} from './device-state/agent-chat-composer-listeners';
import { configureAgentChatComposerWindowForBot } from './device-state/agent-chat-composer-scope';
import { agentChatComposerState } from './device-state/agent-chat-composer-state';

/**
 * Unsent composer text per Chat Terminal. Switching tabs or Sessions unmounts a Chat's composer, and the draft must
 * survive that the way a Terminal's typed-but-unsent line does; it also survives quitting Caxri, so it is mirrored to
 * the device store (`agent-chat-composer-state.ts`). A draft is never written through to Server Core: it is this
 * device's unsent input, not Session state. Reads are synchronous from memory; the Chat pane waits for the stored state
 * before it mounts (`useAgentChatComposerReady`).
 */

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
    /**
     * The number its `[Image #N]` placeholder carries in the draft, fixed while the draft is written
     * (`agent-chat-image-placeholders.ts`). Missing for an image that was never written into the text.
     */
    token?: number;
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
 * Keeps the Caxri Bot window's unsent images, text drafts, and "Edit from here" in its own scope (see
 * `AgentChatComposerWindow`). Called from its entry before the first render, before any composer reads its state.
 */
export function configureAgentChatAttachmentsForBot(): void {
    configureAgentChatComposerWindowForBot();
}

export function readAgentChatDraft(terminalId: string): string {
    return agentChatComposerState.drafts().get(terminalId) ?? '';
}

export function writeAgentChatDraft(terminalId: string, text: string): void {
    const current = agentChatComposerState.drafts();
    if (current.get(terminalId) === text || (!text && !current.has(terminalId))) return;
    current.delete(terminalId);
    if (text) current.set(terminalId, text);
    agentChatComposerState.saveDraft(terminalId, text);
    notifyDraftChange(terminalId);
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
 * `text` continuing the draft's last line, after a space unless the draft is empty or already ends in whitespace: how
 * an inline mention such as an editor's `@path#L12` joins the sentence the user is writing.
 */
export function draftWithInlineText(draft: string, text: string): string {
    return !draft || /\s$/u.test(draft) ? `${draft}${text}` : `${draft} ${text}`;
}

/**
 * Adds `text` to the end of a Chat's draft without sending it: into the composer on screen when it is mounted,
 * otherwise into the stored draft it opens with. It starts a new paragraph unless `join` says otherwise. During "Edit
 * from here" the draft is the edited message, which Cancel discards, so the edit also records `text` for Cancel to put
 * back (`draftAfterEditCancel`).
 */
export function appendToAgentChatDraft(
    terminalId: string,
    text: string,
    join: (draft: string, text: string) => string = draftWithParagraph,
): void {
    const edit = readAgentChatEdit(terminalId);
    if (edit)
        writeAgentChatEdit(terminalId, {
            ...edit,
            appendedDraft: join(edit.appendedDraft, text),
        });
    updateAgentChatDraft(terminalId, (draft) => join(draft, text));
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
    return agentChatComposerState.attachments().get(terminalId) ?? [];
}

export function writeAgentChatAttachments(
    terminalId: string,
    next: readonly AgentChatAttachment[],
): void {
    const attachments = agentChatComposerState.attachments();
    if (next.length > 0) attachments.set(terminalId, [...next]);
    else attachments.delete(terminalId);
    agentChatComposerState.saveAttachments(terminalId, next);
}

/**
 * Releases the composer state of every Chat outside `chatTerminalIds` within this window's composer scope
 * (`agentChatComposerScope`), never another window's: its unsent images (up to the attachment budget per Chat) and its
 * "Edit from here", in memory and stored. Nothing else frees them, so a Chat that was closed, deleted with its Session
 * or Project, or switched to the Terminal surface would hold them until the window reloads. The Workbench calls this
 * whenever the set of Chat Terminals it knows changes.
 *
 * The text draft is deliberately kept: it is bounded and trimmed by recency when persisted (see
 * `MAX_PERSISTED_AGENT_CHAT_DRAFTS`), and dropping it on a transient snapshot gap would lose typed text that should
 * survive a restart. Append listeners need nothing here; a composer removes its own when it unmounts.
 */
export function retainAgentChatComposerState(chatTerminalIds: ReadonlySet<string>): void {
    agentChatComposerState.retain(chatTerminalIds);
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
 * Puts a message whose send failed back into its Chat's composer, ahead of anything typed or attached since: into the
 * composer on screen when it is mounted, otherwise into the stored draft and attachments it opens with.
 */
export function returnUnsentAgentChatMessage(
    terminalId: string,
    text: string,
    sent: readonly AgentChatAttachment[],
): void {
    if (didDeliverToMountedComposer(terminalId, text, sent)) return;
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
