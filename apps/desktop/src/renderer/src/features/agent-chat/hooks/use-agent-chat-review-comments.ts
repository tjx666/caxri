import { useState } from 'react';

import { appendToAgentChatDraft } from '../agent-chat-drafts';
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
 * A comment already added to the Chat's composer, kept under its lines so the review shows what was said. It lives only
 * as long as the tab: the composer holds the text that matters.
 */
export interface AddedReviewComment {
    id: number;
    path: string;
    range: AgentChatReviewRange;
    comment: AgentChatReviewComment;
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
    const [added, setAdded] = useState<readonly AddedReviewComment[]>([]);
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
        appendToAgentChatDraft(terminalId, formatAgentChatReviewComment(comment, projectRoot));
        setAdded((current) => [
            ...current,
            { id: current.length, path: draft.path, range: draft.range, comment },
        ]);
        setDraft(undefined);
    };
    return { draft, added, begin, write, cancel, addToChat };
}
