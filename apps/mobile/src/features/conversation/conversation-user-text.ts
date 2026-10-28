import { agentChatSessionHandoffDraft, parseAgentChatSessionHandoff } from '@caxri/protocol';

/**
 * How a sent user message reads: its own words, or a Desktop `/new-session` hand-off whose instructions to the Agent
 * must never show as the reader's bubble.
 */
export type ConversationUserText =
    { kind: 'handoff'; note: string } | { kind: 'plain'; text: string };

export const conversationUserText = (text: string): ConversationUserText => {
    const handoff = parseAgentChatSessionHandoff(text);
    return handoff ? { kind: 'handoff', note: handoff.note } : { kind: 'plain', text };
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
