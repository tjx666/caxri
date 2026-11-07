import { proseWebLinks } from '@caxri/markdown/prose-web-links';
import type { UserMessageBlock } from '@caxri/markdown/user-message-blocks';
import { userMessageBlocks } from '@caxri/markdown/user-message-blocks';
import { agentChatSessionHandoffDraft, parseAgentChatSessionHandoff } from '@caxri/protocol';

/**
 * How a sent user message reads: its own words laid out as Desktop's bubble lays them out (`userMessageBlocks`), or a
 * Desktop `/new-session` hand-off whose instructions to the Agent must never show as the reader's bubble.
 */
export type ConversationUserText =
    | { kind: 'handoff'; note: string }
    | { kind: 'plain'; blocks: Array<UserMessageBlock<ConversationUserTextRun>>; text: string };

/**
 * A run of a plain user message: its words, or a web link they pasted. `from` is its offset in the message.
 */
export type ConversationUserTextRun =
    | { kind: 'text'; from: number; text: string }
    | { kind: 'url'; from: number; text: string; url: string };

/**
 * Splits a user's words around the `http(s)://` URLs in them, with the rules that link a URL in a reply (see
 * `proseWebLinks`), so a pasted pull request link opens from the bubble as it does on Desktop.
 */
export const conversationUserTextRuns = (text: string): ConversationUserTextRun[] => {
    const runs: ConversationUserTextRun[] = [];
    let offset = 0;
    for (const link of proseWebLinks(text)) {
        if (link.index > offset)
            runs.push({ kind: 'text', from: offset, text: text.slice(offset, link.index) });
        runs.push({ kind: 'url', from: link.index, text: link.text, url: link.url });
        offset = link.index + link.text.length;
    }
    if (offset < text.length) runs.push({ kind: 'text', from: offset, text: text.slice(offset) });
    return runs;
};

export const conversationUserText = (text: string): ConversationUserText => {
    const handoff = parseAgentChatSessionHandoff(text);
    return handoff
        ? { kind: 'handoff', note: handoff.note }
        : { kind: 'plain', blocks: userMessageBlocks(text, conversationUserTextRuns(text)), text };
};

type ConversationUserRun = UserMessageBlock<ConversationUserTextRun>['runs'][number];

/**
 * Splits a list line into its marker (leading indent, the bullet or number, and the spaces after it: the block's
 * `indent` characters) and its content, so the phone can hang wrapped content after the marker the way Desktop's `ch`
 * hanging indent does. A bullet counts as the one character it replaced.
 */
export const conversationUserListLine = (
    block: UserMessageBlock<ConversationUserTextRun>,
): { content: ConversationUserRun[]; marker: ConversationUserRun[] } => {
    const marker: ConversationUserRun[] = [];
    const content: ConversationUserRun[] = [];
    let left = block.indent ?? 0;
    for (const run of block.runs) {
        if (left <= 0) content.push(run);
        else if (run.kind === 'text' && run.text.length > left) {
            marker.push({ ...run, text: run.text.slice(0, left) });
            content.push({ ...run, text: run.text.slice(left) });
            left = 0;
        } else {
            marker.push(run);
            left -= run.kind === 'bullet' ? 1 : run.kind === 'text' ? run.text.length : left;
        }
    }
    return { content, marker };
};

/**
 * The words behind a message for Copy, Select Text, and Edit from Here: the message itself, or for a hand-off the
 * user's note (`/new-session` when they gave none), never the instructions the composer wrote for the Agent.
 */
export const conversationActionText = (text: string): string => {
    const user = conversationUserText(text);
    if (user.kind === 'plain') return text;
    return user.note || agentChatSessionHandoffDraft(text);
};
