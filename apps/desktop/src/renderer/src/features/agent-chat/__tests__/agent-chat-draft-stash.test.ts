import { describe, expect, it } from 'vitest';

import {
    decideAgentChatStashAction,
    isAgentChatDraftStashKey,
    readAgentChatDraftStash,
    restoredAgentChatDraftText,
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

describe('decideAgentChatStashAction', () => {
    const decide = (draft: string, hasStash: boolean, attachmentCount = 0) =>
        decideAgentChatStashAction({ attachmentCount, draft, hasStash });

    it('stashes a draft when nothing is stashed', () => {
        expect(decide('hello', false)).toBe('stash');
        expect(decide('', false, 1)).toBe('stash');
    });

    it('refuses to overwrite an existing stash', () => {
        expect(decide('hello', true)).toBe('refuse-occupied');
        expect(decide('', true, 2)).toBe('refuse-occupied');
    });

    it('restores in an empty or whitespace-only input', () => {
        expect(decide('', true)).toBe('restore');
        expect(decide('\n', true)).toBe('restore');
    });

    it('ignores the key when there is nothing to do', () => {
        expect(decide('', false)).toBe('ignore');
        expect(decide('  \n', false)).toBe('ignore');
    });
});

describe('restoredAgentChatDraftText', () => {
    it('replaces empty and whitespace-only input with the stash', () => {
        expect(restoredAgentChatDraftText('', 'saved')).toBe('saved');
        expect(restoredAgentChatDraftText('\n', 'saved')).toBe('saved');
    });

    it('keeps text the user already typed', () => {
        expect(restoredAgentChatDraftText('next', 'saved')).toBe('next');
    });
});
