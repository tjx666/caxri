import { describe, expect, it } from 'vitest';

import {
    agentChatDraftEndCaret,
    markAgentChatComposerCaretKey,
    markAgentChatComposerSelectionPlaced,
} from '../agent-chat-composer-caret';

function composer(value: string, selectionStart = 0, selectionEnd = selectionStart) {
    return { selectionEnd, selectionStart, value };
}

describe('agentChatDraftEndCaret', () => {
    it('moves the untouched 0..0 selection of a restored draft to its end', () => {
        expect(agentChatDraftEndCaret(composer('restored draft'))).toBe(14);
    });

    it('keeps an empty draft and a selection that is not 0..0', () => {
        expect(agentChatDraftEndCaret(composer(''))).toBeUndefined();
        expect(agentChatDraftEndCaret(composer('draft', 2))).toBeUndefined();
        expect(agentChatDraftEndCaret(composer('draft', 0, 3))).toBeUndefined();
    });

    it('keeps a caret the user clicked or typed to the start of the draft', () => {
        const input = composer('draft');
        markAgentChatComposerSelectionPlaced(input);
        expect(agentChatDraftEndCaret(input)).toBeUndefined();
    });

    it('keeps a caret a modified caret key such as Cmd+Up moved to the start', () => {
        const input = composer('first line\nsecond line');
        markAgentChatComposerCaretKey(input, { key: 'ArrowUp' });
        expect(agentChatDraftEndCaret(input)).toBeUndefined();
    });

    it('does not treat a key that cannot move the caret as a placement', () => {
        const input = composer('draft');
        markAgentChatComposerCaretKey(input, { key: 'Meta' });
        expect(agentChatDraftEndCaret(input)).toBe(5);
    });
});
