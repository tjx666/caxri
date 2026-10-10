import { describe, expect, it } from 'vitest';

import {
    agentChatItemSchema,
    agentChatMethods,
    MAX_AGENT_CHAT_IMAGE_BYTES,
    MAX_AGENT_CHAT_IMAGES,
} from '../agent-chat-contract';
import { applyAgentChatOperation, emptyAgentChatSnapshot } from '../agent-chat-reducer';

const sendParameters = agentChatMethods['agentChat.send'].params;
const THUMBNAIL = 'data:image/jpeg;base64,/9j/4AAQ';
const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=', thumbnail: THUMBNAIL };

describe('Agent Chat input contract', () => {
    it('accepts text, images, or both, but not an empty message', () => {
        expect(sendParameters.safeParse({ terminalId: 't1', text: 'hi' }).success).toBe(true);
        expect(
            sendParameters.safeParse({ terminalId: 't1', text: '  ', images: [image] }).success,
        ).toBe(true);
        expect(sendParameters.safeParse({ terminalId: 't1', text: '  ' }).success).toBe(false);
        expect(sendParameters.safeParse({ terminalId: 't1', text: '', images: [] }).success).toBe(
            false,
        );
    });

    it('bounds the image count, size, and type', () => {
        const tooMany = Array.from({ length: MAX_AGENT_CHAT_IMAGES + 1 }, () => image);
        expect(
            sendParameters.safeParse({ terminalId: 't1', text: '', images: tooMany }).success,
        ).toBe(false);
        const tooLarge = { ...image, data: 'A'.repeat((MAX_AGENT_CHAT_IMAGE_BYTES / 3) * 4 + 8) };
        expect(
            sendParameters.safeParse({ terminalId: 't1', text: '', images: [tooLarge] }).success,
        ).toBe(false);
        const svg = { ...image, mediaType: 'image/svg+xml' };
        expect(
            sendParameters.safeParse({ terminalId: 't1', text: '', images: [svg] }).success,
        ).toBe(false);
    });

    it('renders only inline raster thumbnails', () => {
        const message = (thumbnail: string) => ({
            id: 'u1',
            type: 'userMessage',
            text: '',
            images: [{ thumbnail }],
        });
        expect(agentChatItemSchema.safeParse(message(THUMBNAIL)).success).toBe(true);
        expect(agentChatItemSchema.safeParse(message('https://example.com/a.png')).success).toBe(
            false,
        );
        expect(
            agentChatItemSchema.safeParse(message('data:image/svg+xml;base64,PHN2Zz4=')).success,
        ).toBe(false);
    });

    it('keeps the provider command list across a conversation reset', () => {
        const commands = [{ name: 'compact' }];
        let snapshot = applyAgentChatOperation(emptyAgentChatSnapshot('t1'), {
            op: 'state',
            state: { commands },
        });
        snapshot = applyAgentChatOperation(snapshot, { op: 'reset' });
        expect(snapshot.commands).toEqual(commands);
    });
});
