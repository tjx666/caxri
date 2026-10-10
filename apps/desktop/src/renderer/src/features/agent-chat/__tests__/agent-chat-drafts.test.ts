import { describe, expect, it } from 'vitest';

import {
    draftAfterSend,
    draftWithInsertion,
    readAgentChatDraft,
    writeAgentChatDraft,
} from '../agent-chat-drafts';

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

describe('draftWithInsertion', () => {
    it.each([
        ['', 0, 0, { draft: 'src/a.ts ', caret: 9 }],
        ['look at', 7, 7, { draft: 'look at src/a.ts ', caret: 17 }],
        ['look  please', 5, 5, { draft: 'look src/a.ts please', caret: 13 }],
        ['fix this now', 4, 8, { draft: 'fix src/a.ts now', caret: 12 }],
    ])('inserts into %j at [%i, %i)', (draft, start, end, expected) => {
        expect(draftWithInsertion(draft, start, end, 'src/a.ts')).toEqual(expected);
    });
});
