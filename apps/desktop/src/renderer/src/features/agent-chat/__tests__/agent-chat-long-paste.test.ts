import {
    AGENT_CHAT_LONG_PASTE_THRESHOLD,
    MAX_AGENT_CHAT_MESSAGE_LENGTH,
    MAX_LONG_PASTE_BYTES,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatPasteDisposition,
    canAgentChatPasteFitAsText,
    draftWithLongPasteAsText,
    draftWithPlainPaste,
} from '../agent-chat-long-paste';

const threshold = AGENT_CHAT_LONG_PASTE_THRESHOLD;

describe('agentChatPasteDisposition', () => {
    it('keeps ordinary pastes inline', () => {
        expect(
            agentChatPasteDisposition({
                currentLength: 0,
                pasted: 'hello',
                selectedLength: 0,
                threshold,
            }),
        ).toBe('inline');
        expect(
            agentChatPasteDisposition({
                currentLength: 0,
                pasted: 'x'.repeat(AGENT_CHAT_LONG_PASTE_THRESHOLD),
                selectedLength: 0,
                threshold,
            }),
        ).toBe('inline');
        // An image-only paste carries no text.
        expect(
            agentChatPasteDisposition({
                currentLength: MAX_AGENT_CHAT_MESSAGE_LENGTH,
                pasted: '',
                selectedLength: 0,
                threshold,
            }),
        ).toBe('inline');
    });

    it('saves a paste past the threshold to a file', () => {
        expect(
            agentChatPasteDisposition({
                currentLength: 0,
                pasted: 'x'.repeat(AGENT_CHAT_LONG_PASTE_THRESHOLD + 1),
                selectedLength: 0,
                threshold,
            }),
        ).toBe('file');
    });

    it('saves a short paste the message limit would cut, counting the selection it replaces', () => {
        const nearlyFull = MAX_AGENT_CHAT_MESSAGE_LENGTH - 5_000;
        expect(
            agentChatPasteDisposition({
                currentLength: nearlyFull,
                pasted: 'x'.repeat(5_001),
                selectedLength: 0,
                threshold,
            }),
        ).toBe('file');
        expect(
            agentChatPasteDisposition({
                currentLength: nearlyFull,
                pasted: 'x'.repeat(5_001),
                selectedLength: 1,
                threshold,
            }),
        ).toBe('inline');
    });

    it('refuses a paste whose file reference would not fit in the message', () => {
        expect(
            agentChatPasteDisposition({
                currentLength: MAX_AGENT_CHAT_MESSAGE_LENGTH - 100,
                pasted: 'x'.repeat(200),
                selectedLength: 0,
                threshold,
            }),
        ).toBe('no-room');
        // Replacing most of the draft frees the room again.
        expect(
            agentChatPasteDisposition({
                currentLength: MAX_AGENT_CHAT_MESSAGE_LENGTH - 100,
                pasted: 'x'.repeat(200),
                selectedLength: 50_000,
                threshold,
            }),
        ).toBe('inline');
        expect(
            agentChatPasteDisposition({
                currentLength: MAX_AGENT_CHAT_MESSAGE_LENGTH - 10_000,
                pasted: 'x'.repeat(AGENT_CHAT_LONG_PASTE_THRESHOLD + 1),
                selectedLength: 0,
                threshold,
            }),
        ).toBe('file');
    });

    it('refuses text past the local file safety limit', () => {
        expect(
            agentChatPasteDisposition({
                currentLength: 0,
                pasted: 'x'.repeat(MAX_LONG_PASTE_BYTES + 1),
                selectedLength: 0,
                threshold,
            }),
        ).toBe('too-large');
    });

    it('keeps a long paste inline under a raised threshold, but still saves one the message cannot hold', () => {
        const raised = MAX_AGENT_CHAT_MESSAGE_LENGTH;
        const log = 'x'.repeat(40 * 1024);
        expect(
            agentChatPasteDisposition({
                currentLength: 0,
                pasted: log,
                selectedLength: 0,
                threshold,
            }),
        ).toBe('file');
        expect(
            agentChatPasteDisposition({
                currentLength: 0,
                pasted: log,
                selectedLength: 0,
                threshold: raised,
            }),
        ).toBe('inline');
        expect(
            agentChatPasteDisposition({
                currentLength: 0,
                pasted: 'x'.repeat(MAX_AGENT_CHAT_MESSAGE_LENGTH + 1),
                selectedLength: 0,
                threshold: raised,
            }),
        ).toBe('file');
        // The draft's own text still counts against the message limit.
        expect(
            agentChatPasteDisposition({
                currentLength: MAX_AGENT_CHAT_MESSAGE_LENGTH - log.length + 1,
                pasted: log,
                selectedLength: 0,
                threshold: raised,
            }),
        ).toBe('file');
    });
});

describe('canAgentChatPasteFitAsText', () => {
    it('offers Paste as Text only when the text fits the message in place of the selection', () => {
        const pasted = 'x'.repeat(100);
        expect(
            canAgentChatPasteFitAsText({
                currentLength: MAX_AGENT_CHAT_MESSAGE_LENGTH - 100,
                pasted,
                selectedLength: 0,
            }),
        ).toBe(true);
        expect(
            canAgentChatPasteFitAsText({
                currentLength: MAX_AGENT_CHAT_MESSAGE_LENGTH - 99,
                pasted,
                selectedLength: 0,
            }),
        ).toBe(false);
        expect(
            canAgentChatPasteFitAsText({
                currentLength: MAX_AGENT_CHAT_MESSAGE_LENGTH,
                pasted,
                selectedLength: 100,
            }),
        ).toBe(true);
    });
});

describe('draftWithLongPasteAsText', () => {
    it('swaps the reference for the pasted text', () => {
        expect(
            draftWithLongPasteAsText('see\n@/tmp/paste.txt\nthanks', '@/tmp/paste.txt', 'log'),
        ).toBe('see\nlog\nthanks');
    });

    it('refuses once the reference left the draft or the text no longer fits', () => {
        expect(draftWithLongPasteAsText('edited', '@/tmp/paste.txt', 'log')).toBeUndefined();
        expect(
            draftWithLongPasteAsText(
                '@/tmp/paste.txt',
                '@/tmp/paste.txt',
                'x'.repeat(MAX_AGENT_CHAT_MESSAGE_LENGTH + 1),
            ),
        ).toBeUndefined();
    });
});

describe('draftWithPlainPaste', () => {
    it('inserts the text exactly over the selection and puts the caret after it', () => {
        expect(draftWithPlainPaste('hello world', 6, 11, 'there')).toEqual({
            draft: 'hello there',
            caret: 11,
        });
    });

    it('refuses a text the message cannot hold rather than cutting it', () => {
        expect(
            draftWithPlainPaste('', 0, 0, 'x'.repeat(MAX_AGENT_CHAT_MESSAGE_LENGTH + 1)),
        ).toBeUndefined();
    });
});
