import { describe, expect, it } from 'vitest';

import {
    readAgentChatDraft,
    subscribeAgentChatDraftUpdates,
    writeAgentChatDraft,
} from '../agent-chat-drafts';
import {
    agentChatPasteAsTextUnavailableReason,
    pasteAgentChatSavedPasteAsText,
    rememberAgentChatSavedPaste,
} from '../agent-chat-long-paste-commands';

const reference = '@/tmp/paste.txt';

describe('Paste as Text', () => {
    it('puts the text back into a stored draft and forgets the paste', () => {
        writeAgentChatDraft('chat-stored', `before\n${reference}\nafter`);
        const pasteId = rememberAgentChatSavedPaste({
            reference,
            terminalId: 'chat-stored',
            text: 'pasted log',
        });
        expect(agentChatPasteAsTextUnavailableReason({ pasteId })).toBeUndefined();
        pasteAgentChatSavedPasteAsText({ pasteId });
        expect(readAgentChatDraft('chat-stored')).toBe('before\npasted log\nafter');
        expect(agentChatPasteAsTextUnavailableReason({ pasteId })).toBe(
            'The saved paste is no longer in the message',
        );
    });

    it('updates the mounted composer instead of the stored draft', () => {
        const updates: string[] = [];
        const unsubscribe = subscribeAgentChatDraftUpdates('chat-mounted', (update) =>
            updates.push(update(`x ${reference} y`)),
        );
        const pasteId = rememberAgentChatSavedPaste({
            reference,
            terminalId: 'chat-mounted',
            text: 'text',
        });
        pasteAgentChatSavedPasteAsText({ pasteId });
        unsubscribe();
        expect(updates).toEqual(['x text y']);
    });

    it('is unavailable once the reference left the draft', () => {
        writeAgentChatDraft('chat-edited', 'the user removed it');
        const pasteId = rememberAgentChatSavedPaste({
            reference,
            terminalId: 'chat-edited',
            text: 'text',
        });
        expect(agentChatPasteAsTextUnavailableReason({ pasteId })).toBe(
            'The saved paste is no longer in the message',
        );
    });

    it('keeps only the most recent pastes', () => {
        writeAgentChatDraft('chat-many', reference);
        const ids = Array.from({ length: 6 }, () =>
            rememberAgentChatSavedPaste({ reference, terminalId: 'chat-many', text: 'text' }),
        );
        expect(agentChatPasteAsTextUnavailableReason({ pasteId: ids[0] })).toBe(
            'The saved paste is no longer in the message',
        );
        expect(agentChatPasteAsTextUnavailableReason({ pasteId: ids[5] })).toBeUndefined();
    });
});
