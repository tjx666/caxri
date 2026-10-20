import { translate } from '../../i18n';
import { draftWithParagraph, readAgentChatDraft, updateAgentChatDraft } from './agent-chat-drafts';
import { readAgentChatEdit, writeAgentChatEdit } from './agent-chat-edit';

/**
 * Keeps a turn review's comments and the Chat's draft in step. A comment lands in the draft as one paragraph of text
 * (`formatAgentChatReviewComment`); that exact paragraph is the comment's identity on the draft side, so the review can
 * count, rewrite, or take back its comments while the composer holds them. A paragraph the user has since rewritten in
 * the composer no longer matches, and the review then stops counting that comment as pending.
 */

/**
 * Whether the draft still holds the comment's paragraph.
 */
export function hasDraftReviewComment(draft: string, paragraph: string): boolean {
    return paragraph !== '' && draft.includes(paragraph);
}

/**
 * For each comment, in order, whether the draft still holds its paragraph: the comments a send would carry. Comments
 * with identical paragraphs claim one occurrence each, so a duplicate the user deleted from the composer is not counted
 * twice.
 */
export function pendingReviewCommentFlags(draft: string, paragraphs: readonly string[]): boolean[] {
    let remaining = draft;
    return paragraphs.map((paragraph) => {
        const index = paragraph === '' ? -1 : remaining.indexOf(paragraph);
        if (index === -1) return false;
        remaining = remaining.slice(0, index) + remaining.slice(index + paragraph.length);
        return true;
    });
}

/**
 * The draft with the first occurrence of `from` replaced by `to`, unchanged when `from` is not there.
 */
export function draftWithReplacedReviewComment(draft: string, from: string, to: string): string {
    const index = from === '' ? -1 : draft.indexOf(from);
    if (index === -1) return draft;
    return draft.slice(0, index) + to + draft.slice(index + from.length);
}

/**
 * The draft without the first occurrence of `paragraph` and the blank line that separated it from its neighbors,
 * unchanged when it is not there.
 */
export function draftWithoutReviewComment(draft: string, paragraph: string): string {
    const index = paragraph === '' ? -1 : draft.indexOf(paragraph);
    if (index === -1) return draft;
    const before = draft.slice(0, index).trimEnd();
    const after = draft.slice(index + paragraph.length).trimStart();
    return before && after ? `${before}\n\n${after}` : before || after;
}

/**
 * Applies `change` to a Chat's draft and, during "Edit from here", to the comments that edit would put back on Cancel
 * (`AgentChatEdit.appendedDraft`), so a comment rewritten or removed here is not resurrected by a Cancel.
 */
function updateDraftAndEdit(terminalId: string, change: (text: string) => string): void {
    const edit = readAgentChatEdit(terminalId);
    if (edit)
        writeAgentChatEdit(terminalId, { ...edit, appendedDraft: change(edit.appendedDraft) });
    updateAgentChatDraft(terminalId, change);
}

/**
 * Rewrites a comment's paragraph in the Chat's draft.
 */
export function replaceAgentChatReviewComment(terminalId: string, from: string, to: string): void {
    updateDraftAndEdit(terminalId, (text) => draftWithReplacedReviewComment(text, from, to));
}

/**
 * Takes a comment's paragraph out of the Chat's draft.
 */
function removeAgentChatReviewComment(terminalId: string, paragraph: string): void {
    updateDraftAndEdit(terminalId, (text) => draftWithoutReviewComment(text, paragraph));
}

/**
 * Puts a removed comment's paragraph back at the end of the Chat's draft (Undo).
 */
function restoreAgentChatReviewComment(terminalId: string, paragraph: string): void {
    updateDraftAndEdit(terminalId, (text) => draftWithParagraph(text, paragraph));
}

/**
 * How many removed comments stay restorable. Memory only and bounded, because each holds a diff snippet that must not
 * ride in a notification's plain data.
 */
const MAX_REMOVED_COMMENTS = 10;

const removedComments = new Map<string, { terminalId: string; paragraph: string }>();

/**
 * Takes a comment out of the Chat's draft and keeps its paragraph for the Undo toast; returns the id that toast
 * carries.
 */
export function removeAgentChatReviewCommentWithUndo(
    terminalId: string,
    paragraph: string,
): string {
    removeAgentChatReviewComment(terminalId, paragraph);
    const restoreId = crypto.randomUUID();
    removedComments.set(restoreId, { terminalId, paragraph });
    for (const id of removedComments.keys()) {
        if (removedComments.size <= MAX_REMOVED_COMMENTS) break;
        removedComments.delete(id);
    }
    return restoreId;
}

/**
 * Why a removed comment can no longer be put back, or `undefined` when it can: it was forgotten (a reload, or newer
 * removals pushed it out) or it already is in the draft.
 */
export function reviewCommentRestoreUnavailableReason({
    restoreId,
}: {
    restoreId: string;
}): string | undefined {
    const removed = removedComments.get(restoreId);
    if (!removed) return translate('agentChat.review.restoreGone');
    return hasDraftReviewComment(readAgentChatDraft(removed.terminalId), removed.paragraph)
        ? translate('agentChat.review.restoreGone')
        : undefined;
}

/**
 * Puts a removed comment back into the Chat's draft; its note returns under its lines with it.
 */
export function restoreRemovedReviewComment({ restoreId }: { restoreId: string }): void {
    const removed = removedComments.get(restoreId);
    if (!removed) return;
    removedComments.delete(restoreId);
    restoreAgentChatReviewComment(removed.terminalId, removed.paragraph);
}
