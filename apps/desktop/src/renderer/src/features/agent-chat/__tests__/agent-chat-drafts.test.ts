import { describe, expect, it } from 'vitest';

import {
    agentChatAttachmentLabel,
    appendToAgentChatDraft,
    draftAfterSend,
    draftWithInsertion,
    readAgentChatAttachments,
    readAgentChatDraft,
    retainAgentChatComposerState,
    subscribeAgentChatDraftAppends,
    writeAgentChatAttachments,
    writeAgentChatDraft,
} from '../agent-chat-drafts';
import { readAgentChatEdit, writeAgentChatEdit } from '../agent-chat-edit';

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

    it('releases the images and edit of a Chat that is gone, keeping those of open Chats and every text draft', () => {
        const image = { mediaType: 'image/png', data: 'AAAA', thumbnail: 'AAAA' } as const;
        const edit = { itemId: 'message-1', restoreFiles: false, previousDraft: '' };
        for (const terminalId of ['chat-open', 'chat-closed']) {
            writeAgentChatDraft(terminalId, `draft of ${terminalId}`);
            writeAgentChatAttachments(terminalId, [{ id: `${terminalId}-image`, image }]);
            writeAgentChatEdit(terminalId, edit);
        }

        retainAgentChatComposerState(new Set(['chat-open']));

        expect(readAgentChatAttachments('chat-closed')).toEqual([]);
        expect(readAgentChatEdit('chat-closed')).toBeUndefined();
        expect(readAgentChatDraft('chat-closed')).toBe('draft of chat-closed');
        expect(readAgentChatAttachments('chat-open')).toHaveLength(1);
        expect(readAgentChatEdit('chat-open')).toEqual(edit);
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

    it.each([
        ['', 0, { draft: 'a\nb\n', caret: 4 }],
        ['see notes.txt ', 14, { draft: 'see notes.txt \na\nb\n', caret: 19 }],
        ['before\nafter', 7, { draft: 'before\na\nb\nafter', caret: 11 }],
    ])('sets a multi-line insertion into %j at %i on lines of its own', (draft, at, expected) => {
        expect(draftWithInsertion(draft, at, at, 'a\nb')).toEqual(expected);
    });
});
