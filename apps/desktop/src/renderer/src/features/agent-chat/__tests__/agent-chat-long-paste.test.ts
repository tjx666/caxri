import {
    AGENT_CHAT_LONG_PASTE_THRESHOLD,
    MAX_AGENT_CHAT_MESSAGE_LENGTH,
    MAX_LONG_PASTE_BYTES,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentChatPasteDisposition } from '../agent-chat-long-paste';

describe('agentChatPasteDisposition', () => {
    it('keeps ordinary pastes inline', () => {
        expect(
            agentChatPasteDisposition({ currentLength: 0, pasted: 'hello', selectedLength: 0 }),
        ).toBe('inline');
        expect(
            agentChatPasteDisposition({
                currentLength: 0,
                pasted: 'x'.repeat(AGENT_CHAT_LONG_PASTE_THRESHOLD),
                selectedLength: 0,
            }),
        ).toBe('inline');
        // An image-only paste carries no text.
        expect(
            agentChatPasteDisposition({
                currentLength: MAX_AGENT_CHAT_MESSAGE_LENGTH,
                pasted: '',
                selectedLength: 0,
            }),
        ).toBe('inline');
    });

    it('saves a paste past the threshold to a file', () => {
        expect(
            agentChatPasteDisposition({
                currentLength: 0,
                pasted: 'x'.repeat(AGENT_CHAT_LONG_PASTE_THRESHOLD + 1),
                selectedLength: 0,
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
            }),
        ).toBe('file');
        expect(
            agentChatPasteDisposition({
                currentLength: nearlyFull,
                pasted: 'x'.repeat(5_001),
                selectedLength: 1,
            }),
        ).toBe('inline');
    });

    it('refuses a paste whose file reference would not fit in the message', () => {
        expect(
            agentChatPasteDisposition({
                currentLength: MAX_AGENT_CHAT_MESSAGE_LENGTH - 100,
                pasted: 'x'.repeat(200),
                selectedLength: 0,
            }),
        ).toBe('no-room');
        // Replacing most of the draft frees the room again.
        expect(
            agentChatPasteDisposition({
                currentLength: MAX_AGENT_CHAT_MESSAGE_LENGTH - 100,
                pasted: 'x'.repeat(200),
                selectedLength: 50_000,
            }),
        ).toBe('inline');
        expect(
            agentChatPasteDisposition({
                currentLength: MAX_AGENT_CHAT_MESSAGE_LENGTH - 10_000,
                pasted: 'x'.repeat(AGENT_CHAT_LONG_PASTE_THRESHOLD + 1),
                selectedLength: 0,
            }),
        ).toBe('file');
    });

    it('refuses text past the local file safety limit', () => {
        expect(
            agentChatPasteDisposition({
                currentLength: 0,
                pasted: 'x'.repeat(MAX_LONG_PASTE_BYTES + 1),
                selectedLength: 0,
            }),
        ).toBe('too-large');
    });
});
