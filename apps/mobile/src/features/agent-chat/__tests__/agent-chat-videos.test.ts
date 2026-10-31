import { describe, expect, it } from 'vitest';

import {
    agentChatVideoBlocker,
    agentChatVideoPaths,
    readAgentChatVideoPoster,
} from '../agent-chat-videos';

describe('agentChatVideoPaths', () => {
    it('lists the videos each user message cites, keyed for the Chat view', () => {
        expect(
            agentChatVideoPaths({
                items: [
                    {
                        id: 'u1',
                        turnId: 't1',
                        type: 'userMessage',
                        text: 'Compare /tmp/a.mp4 with /tmp/b.mov and /tmp/a.mp4 and /tmp/notes.md',
                    },
                    { id: 'u2', turnId: 't2', type: 'userMessage', text: 'No video here' },
                    {
                        id: 'a1',
                        turnId: 't1',
                        type: 'agentMessage',
                        text: '/tmp/c.mp4',
                        streaming: false,
                    },
                ],
            }),
        ).toBe('[["u1",["/tmp/a.mp4","/tmp/b.mov"]]]');
        expect(agentChatVideoPaths(undefined)).toBe('');
    });
});

describe('readAgentChatVideoPoster', () => {
    const chunk = (data: string, chunkIndex: number, chunkCount: number) => ({
        poster: { mediaType: 'image/jpeg' as const, data, chunkIndex, chunkCount },
    });

    it('joins every chunk of the poster into a data URI', async () => {
        const parts = ['QUJD', 'REVG'];
        await expect(
            readAgentChatVideoPoster((index) => Promise.resolve(chunk(parts[index], index, 2))),
        ).resolves.toEqual({ kind: 'ready', uri: 'data:image/jpeg;base64,QUJDREVG' });
    });

    it('reads a deleted file as unavailable and a missing frame as no poster', async () => {
        await expect(readAgentChatVideoPoster(() => Promise.resolve(null))).resolves.toEqual({
            kind: 'unavailable',
        });
        await expect(
            readAgentChatVideoPoster(() => Promise.resolve({ poster: null })),
        ).resolves.toEqual({ kind: 'ready', uri: null });
    });

    it('fails when the poster changes between chunks', async () => {
        await expect(
            readAgentChatVideoPoster((index) =>
                Promise.resolve(index === 0 ? chunk('QUJD', 0, 2) : chunk('REVG', 1, 3)),
            ),
        ).rejects.toThrow('changed');
    });
});

describe('agentChatVideoBlocker', () => {
    it('plays only over a live direct connection', () => {
        expect(agentChatVideoBlocker({ route: 'direct', status: 'connected' })).toBeNull();
        expect(agentChatVideoBlocker({ route: 'relay', status: 'connected' })).toMatch(
            /Relay|relay/u,
        );
        expect(agentChatVideoBlocker({ route: 'direct', status: 'reconnecting' })).toMatch(
            /Reconnect/u,
        );
    });
});
