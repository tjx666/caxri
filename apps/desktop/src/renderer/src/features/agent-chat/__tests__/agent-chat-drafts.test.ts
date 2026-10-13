import { describe, expect, it, vi } from 'vitest';

import {
    agentChatAttachmentLabel,
    agentChatAttachmentName,
    agentChatAttachmentsWithPaths,
    appendToAgentChatDraft,
    attachmentsWithReturned,
    didDeliverAgentChatComposerInput,
    draftAfterEditCancel,
    draftAfterSend,
    draftWithInsertion,
    readAgentChatAttachments,
    readAgentChatDraft,
    retainAgentChatComposerState,
    returnUnsentAgentChatMessage,
    subscribeAgentChatDraftUpdates,
    subscribeAgentChatUnsentReturns,
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
        const unsubscribe = subscribeAgentChatDraftUpdates('chat-c', (update) =>
            received.push(update('')),
        );
        appendToAgentChatDraft('chat-c', 'second');
        expect(received).toEqual(['second']);
        expect(readAgentChatDraft('chat-c')).toBe('Please fix:\n\nfirst');

        unsubscribe();
        appendToAgentChatDraft('chat-d', 'alone');
        expect(readAgentChatDraft('chat-d')).toBe('alone');
    });

    it('releases the images and edit of a Chat that is gone, keeping those of open Chats and every text draft', () => {
        const image = { mediaType: 'image/png', data: 'AAAA', thumbnail: 'AAAA' } as const;
        const edit = {
            itemId: 'message-1',
            restoreFiles: false,
            previousDraft: '',
            appendedDraft: '',
        };
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

    it('keeps a review comment added during "Edit from here" for Cancel to put back', () => {
        writeAgentChatEdit('chat-e', {
            itemId: 'u1',
            restoreFiles: false,
            previousDraft: 'set aside',
            appendedDraft: '',
        });
        writeAgentChatDraft('chat-e', 'edited message');
        appendToAgentChatDraft('chat-e', 'first comment');
        expect(readAgentChatDraft('chat-e')).toBe('edited message\n\nfirst comment');

        const received: string[] = [];
        const unsubscribe = subscribeAgentChatDraftUpdates('chat-e', (update) =>
            received.push(update('')),
        );
        appendToAgentChatDraft('chat-e', 'second comment');
        unsubscribe();
        expect(received).toEqual(['second comment']);

        const edit = readAgentChatEdit('chat-e');
        // A sent edit carries the comments in its message, so the draft it brings back stays as it was.
        expect(edit?.previousDraft).toBe('set aside');
        expect(edit && draftAfterEditCancel(edit)).toBe(
            'set aside\n\nfirst comment\n\nsecond comment',
        );
        writeAgentChatEdit('chat-e', undefined);
    });

    it('puts back only the set-aside draft when nothing was appended during the edit', () => {
        expect(draftAfterEditCancel({ previousDraft: 'set aside', appendedDraft: '' })).toBe(
            'set aside',
        );
        expect(draftAfterEditCancel({ previousDraft: '', appendedDraft: 'comment' })).toBe(
            'comment',
        );
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

    it('names an attachment the same way for Remove, without the resized note', () => {
        expect(agentChatAttachmentName({ name: 'diagram.png' }, 0)).toBe('diagram.png');
        expect(agentChatAttachmentName({ name: '' }, 1)).toBe('Attachment 2');
    });
});

describe('returning an unsent message', () => {
    const image = (id: string) => ({
        id,
        image: { mediaType: 'image/png' as const, data: 'AAAA', thumbnail: '' },
    });

    it('puts the message back ahead of what was typed or attached since', () => {
        expect(
            attachmentsWithReturned(
                [image('later'), image('kept')],
                [image('sent'), image('kept')],
            ).map(({ id }) => id),
        ).toEqual(['sent', 'later', 'kept']);
    });

    it('writes the stored composer state, or hands the message to the composer on screen', () => {
        writeAgentChatDraft('chat-r', 'typed since');
        writeAgentChatAttachments('chat-r', [image('later')]);
        returnUnsentAgentChatMessage('chat-r', 'failed', [image('sent')]);
        expect(readAgentChatDraft('chat-r')).toBe('failed\n\ntyped since');
        expect(readAgentChatAttachments('chat-r').map(({ id }) => id)).toEqual(['sent', 'later']);

        // A composer that mounted after the send read the stored state then; only it can merge what was typed since.
        const received: Array<{ text: string; count: number }> = [];
        const unsubscribe = subscribeAgentChatUnsentReturns('chat-r', (text, attachments) =>
            received.push({ text, count: attachments.length }),
        );
        returnUnsentAgentChatMessage('chat-r', 'again', [image('other')]);
        expect(received).toEqual([{ text: 'again', count: 1 }]);
        expect(readAgentChatDraft('chat-r')).toBe('failed\n\ntyped since');
        unsubscribe();
        writeAgentChatDraft('chat-r', '');
        writeAgentChatAttachments('chat-r', []);
    });
});

describe('agentChatAttachmentsWithPaths', () => {
    it('adds a card per new path after the attachments already there', () => {
        const folder = { id: 'a', path: '/work/app', isDirectory: true };
        expect(
            agentChatAttachmentsWithPaths(
                [folder],
                [
                    { id: 'b', path: '/work/app', isDirectory: true },
                    { id: 'c', path: '/work/notes.txt', isDirectory: false },
                    { id: 'd', path: '/work/notes.txt', isDirectory: false },
                ],
            ),
        ).toEqual([folder, { id: 'c', path: '/work/notes.txt', isDirectory: false }]);
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

describe('didDeliverAgentChatComposerInput', () => {
    it('clears the composer before delivery settles, and keeps it clear once delivered', async () => {
        const events: string[] = [];
        const delivery = Promise.withResolvers<boolean>();
        const delivered = didDeliverAgentChatComposerInput({
            clear: () => events.push('clear'),
            deliver: (clear) => {
                clear();
                return delivery.promise;
            },
            restore: () => events.push('restore'),
        });
        expect(events).toEqual(['clear']);
        delivery.resolve(true);
        await expect(delivered).resolves.toBe(true);
        expect(events).toEqual(['clear']);
    });

    it('puts what it cleared back when delivery fails', async () => {
        const events: string[] = [];
        await expect(
            didDeliverAgentChatComposerInput({
                clear: () => events.push('clear'),
                deliver: (clear) => {
                    clear();
                    clear();
                    return Promise.resolve(false);
                },
                restore: () => events.push('restore'),
            }),
        ).resolves.toBe(false);
        expect(events).toEqual(['clear', 'restore']);
    });

    it('leaves the composer alone when the user declined before anything was cleared', async () => {
        const clear = vi.fn();
        const restore = vi.fn();
        await expect(
            didDeliverAgentChatComposerInput({
                clear,
                deliver: () => Promise.resolve(false),
                restore,
            }),
        ).resolves.toBe(false);
        expect(clear).not.toHaveBeenCalled();
        expect(restore).not.toHaveBeenCalled();
    });
});
