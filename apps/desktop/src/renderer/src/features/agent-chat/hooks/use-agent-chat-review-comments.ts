import { useState, useSyncExternalStore } from 'react';

import {
    appendToAgentChatDraft,
    readAgentChatDraft,
    subscribeAgentChatDraftChanges,
} from '../agent-chat-drafts';
import {
    pendingReviewCommentFlags,
    removeAgentChatReviewCommentWithUndo,
    replaceAgentChatReviewComment,
} from '../agent-chat-review-draft';
import type {
    AgentChatReviewComment,
    AgentChatReviewFile,
    AgentChatReviewRange,
} from '../agent-chat-turn-review';
import {
    agentChatReviewComment,
    agentChatReviewRange,
    formatAgentChatReviewComment,
} from '../agent-chat-turn-review';

/**
 * The comment being written: on which file, the line it started on, the range it covers so far, and its text, kept here
 * so extending the range (which moves the card under its new last line) keeps what was typed.
 */
interface ReviewDraft {
    path: string;
    anchor: number;
    range: AgentChatReviewRange;
    text: string;
}

/**
 * A comment added to the Chat's composer, kept under its lines so the review shows what was said. It lives only as long
 * as the tab: the composer holds the text that matters. `paragraph` is the text it put into the draft, which is how the
 * review finds it there again (`agent-chat-review-draft.ts`).
 */
export interface AddedReviewComment {
    id: string;
    path: string;
    range: AgentChatReviewRange;
    comment: AgentChatReviewComment;
    paragraph: string;
}

/**
 * The turn review's comments: one being written at a time, and those already added to the Chat.
 */
export function useAgentChatReviewComments({
    files,
    projectRoot,
    terminalId,
}: {
    files: readonly AgentChatReviewFile[];
    projectRoot: string | undefined;
    terminalId: string;
}) {
    const [draft, setDraft] = useState<ReviewDraft>();
    const [allAdded, setAllAdded] = useState<readonly AddedReviewComment[]>([]);
    const [editing, setEditing] = useState<{ id: string; text: string }>();
    const chatDraft = useSyncExternalStore(
        (listener) => subscribeAgentChatDraftChanges(terminalId, listener),
        () => readAgentChatDraft(terminalId),
    );
    // A comment shows (and counts) only while the composer still holds it: one the user deleted there, took back here,
    // or sent has nothing left to edit or remove.
    const flags = pendingReviewCommentFlags(
        chatDraft,
        allAdded.map((entry) => entry.paragraph),
    );
    const added = allAdded.filter((_, index) => flags[index]);
    /**
     * Starts a comment on line `index`, or when `isExtending` stretches the open comment on the same file to it.
     */
    const begin = (path: string, index: number, isExtending: boolean): void => {
        const file = files.find((candidate) => candidate.file.path === path);
        setDraft((current) => {
            if (!file || !isExtending || current?.path !== path)
                return { path, anchor: index, range: { start: index, end: index }, text: '' };
            const range = agentChatReviewRange(file, current.anchor, index);
            // A line in another hunk restarts the range there; the typed text stays.
            const anchor =
                file.hunks[current.anchor] === file.hunks[index] ? current.anchor : index;
            return { ...current, anchor, range };
        });
    };
    const write = (text: string): void => setDraft((current) => current && { ...current, text });
    const cancel = (): void => setDraft(undefined);
    /**
     * Adds the open comment to the end of the Chat's message without sending it.
     */
    const addToChat = (): void => {
        if (!draft?.text.trim()) return;
        const file = files.find((candidate) => candidate.file.path === draft.path);
        const comment = file && agentChatReviewComment(file, draft.range, draft.text);
        if (!comment) return;
        const paragraph = formatAgentChatReviewComment(comment, projectRoot);
        appendToAgentChatDraft(terminalId, paragraph);
        setAllAdded((current) => [
            ...current,
            { id: crypto.randomUUID(), path: draft.path, range: draft.range, comment, paragraph },
        ]);
        setDraft(undefined);
    };
    const find = (id: string): AddedReviewComment | undefined =>
        allAdded.find((entry) => entry.id === id);
    const beginEdit = (id: string): void => {
        const entry = find(id);
        if (entry) setEditing({ id, text: entry.comment.text });
    };
    const writeEdit = (text: string): void =>
        setEditing((current) => current && { ...current, text });
    const cancelEdit = (): void => setEditing(undefined);
    /**
     * Rewrites the comment being edited in place, in the review and in the Chat's message.
     */
    const saveEdit = (): void => {
        const entry = editing && find(editing.id);
        if (!entry || !editing.text.trim()) return;
        const file = files.find((candidate) => candidate.file.path === entry.path);
        const comment = file && agentChatReviewComment(file, entry.range, editing.text);
        if (!comment) return;
        const paragraph = formatAgentChatReviewComment(comment, projectRoot);
        replaceAgentChatReviewComment(terminalId, entry.paragraph, paragraph);
        setAllAdded((current) =>
            current.map((candidate) =>
                candidate.id === entry.id ? { ...candidate, comment, paragraph } : candidate,
            ),
        );
        setEditing(undefined);
    };
    /**
     * Takes a comment out of the Chat's message. Returns the id the Undo toast carries to put it back, or `undefined`
     * when the comment is already gone.
     */
    const remove = (id: string): string | undefined => {
        const entry = find(id);
        if (!entry) return undefined;
        if (editing?.id === id) setEditing(undefined);
        return removeAgentChatReviewCommentWithUndo(terminalId, entry.paragraph);
    };
    return {
        draft,
        added,
        editing,
        pendingCount: added.length,
        begin,
        write,
        cancel,
        addToChat,
        beginEdit,
        writeEdit,
        cancelEdit,
        saveEdit,
        remove,
    };
}
