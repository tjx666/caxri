import { afterEach, describe, expect, it } from 'vitest';

import {
    agentChatSentImageOriginal,
    clearAgentChatSentImageOriginals,
    retainAgentChatSentImageOriginals,
} from '../agent-chat-sent-image-originals';

afterEach(() => clearAgentChatSentImageOriginals());

describe('agentChatSentImageOriginal', () => {
    it('returns the original sent behind a thumbnail', () => {
        retainAgentChatSentImageOriginals([
            { mediaType: 'image/png', data: 'AAAA', thumbnail: 'data:image/jpeg;base64,t1' },
        ]);

        expect(agentChatSentImageOriginal('data:image/jpeg;base64,t1')).toBe(
            'data:image/png;base64,AAAA',
        );
        expect(agentChatSentImageOriginal('data:image/jpeg;base64,t2')).toBeUndefined();
        expect(agentChatSentImageOriginal(undefined)).toBeUndefined();
    });

    it('drops the oldest originals past the retention budget', () => {
        const large = 'A'.repeat(40 * 1024 * 1024);
        retainAgentChatSentImageOriginals([
            { mediaType: 'image/png', data: large, thumbnail: 'first' },
        ]);
        retainAgentChatSentImageOriginals([
            { mediaType: 'image/png', data: large, thumbnail: 'second' },
        ]);

        expect(agentChatSentImageOriginal('first')).toBeUndefined();
        expect(agentChatSentImageOriginal('second')).toBeDefined();
    });
});
