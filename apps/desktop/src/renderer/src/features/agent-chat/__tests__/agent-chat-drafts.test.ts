import { describe, expect, it } from 'vitest';

import { draftAfterSend, readAgentChatDraft, writeAgentChatDraft } from '../agent-chat-drafts';

describe('Agent Chat drafts', () => {
    it('keeps one draft per Chat and forgets an emptied one', () => {
        writeAgentChatDraft('chat-a', 'half written');
        writeAgentChatDraft('chat-b', 'other');
        expect(readAgentChatDraft('chat-a')).toBe('half written');
        expect(readAgentChatDraft('chat-b')).toBe('other');
        writeAgentChatDraft('chat-a', '');
        expect(readAgentChatDraft('chat-a')).toBe('');
    });

    it('clears only the text that was sent, keeping anything typed while the send was in flight', () => {
        expect(draftAfterSend('first', 'first')).toBe('');
        expect(draftAfterSend('first and more', 'first')).toBe('first and more');
        expect(draftAfterSend('', 'first')).toBe('');
    });
});
