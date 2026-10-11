import { describe, expect, it } from 'vitest';

import {
    agentChatAttachmentLabel,
    agentChatPasteTruncationWarning,
    appendToAgentChatDraft,
    draftAfterSend,
    draftWithInsertion,
    readAgentChatDraft,
    subscribeAgentChatDraftAppends,
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

    it('appends a paragraph to the stored draft, or hands it to the composer on screen', () => {
        writeAgentChatDraft('chat-c', 'Please fix:  ');
        appendToAgentChatDraft('chat-c', 'first');
        expect(readAgentChatDraft('chat-c')).toBe('Please fix:\n\nfirst');

        const received: string[] = [];
        const unsubscribe = subscribeAgentChatDraftAppends('chat-c', (text) => received.push(text));
        appendToAgentChatDraft('chat-c', 'second');
        expect(received).toEqual(['second']);
        expect(readAgentChatDraft('chat-c')).toBe('Please fix:\n\nfirst');

        unsubscribe();
        appendToAgentChatDraft('chat-d', 'alone');
        expect(readAgentChatDraft('chat-d')).toBe('alone');
    });

    it('clears only the text that was sent, keeping anything typed while the send was in flight', () => {
        expect(draftAfterSend('first', 'first')).toBe('');
        expect(draftAfterSend('first and more', 'first')).toBe('first and more');
        expect(draftAfterSend('', 'first')).toBe('');
    });

    it('names an attachment chip by its file name, falling back to its position', () => {
        expect(agentChatAttachmentLabel({ name: 'diagram.png' }, 0)).toBe('diagram.png');
        expect(agentChatAttachmentLabel({ name: '' }, 1)).toBe('Attachment 2');
        expect(agentChatAttachmentLabel({}, 2)).toBe('Attachment 3');
    });

    it('warns only when a paste would pass the message limit', () => {
        expect(
            agentChatPasteTruncationWarning(
                { currentLength: 4, pastedLength: 6, selectedLength: 0 },
                10,
            ),
        ).toBeUndefined();
        // The selection the paste replaces frees room.
        expect(
            agentChatPasteTruncationWarning(
                { currentLength: 8, pastedLength: 6, selectedLength: 4 },
                10,
            ),
        ).toBeUndefined();
        expect(
            agentChatPasteTruncationWarning(
                { currentLength: 8, pastedLength: 6, selectedLength: 0 },
                100_000,
            ),
        ).toBeUndefined();
        expect(
            agentChatPasteTruncationWarning(
                { currentLength: 99_998, pastedLength: 3, selectedLength: 0 },
                100_000,
            ),
        ).toBe('Pasted text was cut off at the 100,000-character message limit');
        // An image-only paste carries no text to cut.
        expect(
            agentChatPasteTruncationWarning(
                { currentLength: 100_000, pastedLength: 0, selectedLength: 0 },
                100_000,
            ),
        ).toBeUndefined();
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
