import { describe, expect, it } from 'vitest';

import {
    isAgentChatDraftStashKey,
    readAgentChatDraftStash,
    writeAgentChatDraftStash,
} from '../agent-chat-draft-stash';

const bare = {
    altKey: false,
    ctrlKey: true,
    isComposing: false,
    metaKey: false,
    shiftKey: false,
};

describe('isAgentChatDraftStashKey', () => {
    it('is Ctrl+S alone, outside IME composition', () => {
        expect(isAgentChatDraftStashKey({ ...bare, key: 's' })).toBe(true);
        expect(isAgentChatDraftStashKey({ ...bare, key: 'S' })).toBe(true);
        expect(isAgentChatDraftStashKey({ ...bare, ctrlKey: false, metaKey: true, key: 's' })).toBe(
            false,
        );
        for (const modifier of ['altKey', 'metaKey', 'shiftKey', 'isComposing'])
            expect(isAgentChatDraftStashKey({ ...bare, [modifier]: true, key: 's' })).toBe(false);
        expect(isAgentChatDraftStashKey({ ...bare, key: 'a' })).toBe(false);
    });
});

describe('agent chat draft stash', () => {
    it('keeps one stash per Chat until it is cleared', () => {
        const stash = { text: 'long prompt', caret: 4, attachments: [], isGoalMode: true };
        writeAgentChatDraftStash('chat-1', stash);
        expect(readAgentChatDraftStash('chat-1')).toEqual(stash);
        expect(readAgentChatDraftStash('chat-2')).toBeUndefined();
        writeAgentChatDraftStash('chat-1', undefined);
        expect(readAgentChatDraftStash('chat-1')).toBeUndefined();
    });
});
