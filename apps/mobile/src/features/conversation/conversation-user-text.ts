import { proseWebLinks } from '@caxri/markdown/prose-web-links';
import { agentChatSessionHandoffDraft, parseAgentChatSessionHandoff } from '@caxri/protocol';

/**
 * How a sent user message reads: its own words, or a Desktop `/new-session` hand-off whose instructions to the Agent
 * must never show as the reader's bubble.
 */
export type ConversationUserText =
    | { kind: 'handoff'; note: string }
    | { kind: 'plain'; runs: ConversationUserTextRun[]; text: string };

/**
 * A run of a plain user message: its words, or a web link they pasted.
 */
export type ConversationUserTextRun =
    { kind: 'text'; text: string } | { kind: 'url'; text: string; url: string };

/**
 * Splits a user's words around the `http(s)://` URLs in them, with the rules that link a URL in a reply (see
 * `proseWebLinks`), so a pasted pull request link opens from the bubble as it does on Desktop.
 */
export const conversationUserTextRuns = (text: string): ConversationUserTextRun[] => {
    const runs: ConversationUserTextRun[] = [];
    let offset = 0;
    for (const link of proseWebLinks(text)) {
        if (link.index > offset) runs.push({ kind: 'text', text: text.slice(offset, link.index) });
        runs.push({ kind: 'url', text: link.text, url: link.url });
        offset = link.index + link.text.length;
    }
    if (offset < text.length) runs.push({ kind: 'text', text: text.slice(offset) });
    return runs;
};

export const conversationUserText = (text: string): ConversationUserText => {
    const handoff = parseAgentChatSessionHandoff(text);
    return handoff
        ? { kind: 'handoff', note: handoff.note }
        : { kind: 'plain', runs: conversationUserTextRuns(text), text };
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
