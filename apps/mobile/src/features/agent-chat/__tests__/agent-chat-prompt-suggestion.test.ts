import { describe, expect, it } from 'vitest';

import { agentChatOfferedPromptSuggestion } from '../agent-chat-prompt-suggestion';

describe('agentChatOfferedPromptSuggestion', () => {
    const snapshot = {
        activeTurnId: undefined,
        promptSuggestion: { text: 'Run the tests', lastResponseAt: 100 },
        usage: { lastResponseAt: 100 },
    };
    const idle = { draft: '', isEditable: true, isEditing: false, isMenuOpen: false, snapshot };

    it('offers the current suggestion to an empty composer that can send', () => {
        expect(agentChatOfferedPromptSuggestion(idle as never)).toBe('Run the tests');
    });

    it('offers nothing once the input holds text, an edit, or an open menu', () => {
        expect(agentChatOfferedPromptSuggestion({ ...idle, draft: 'h' } as never)).toBeUndefined();
        expect(
            agentChatOfferedPromptSuggestion({ ...idle, isEditing: true } as never),
        ).toBeUndefined();
        expect(
            agentChatOfferedPromptSuggestion({ ...idle, isMenuOpen: true } as never),
        ).toBeUndefined();
    });

    it('offers nothing while the composer cannot send', () => {
        expect(
            agentChatOfferedPromptSuggestion({ ...idle, isEditable: false } as never),
        ).toBeUndefined();
    });

    it('drops the suggestion once a turn runs or a newer reply landed', () => {
        const running = { ...snapshot, activeTurnId: 't1' };
        const newer = { ...snapshot, usage: { lastResponseAt: 200 } };
        expect(
            agentChatOfferedPromptSuggestion({ ...idle, snapshot: running } as never),
        ).toBeUndefined();
        expect(
            agentChatOfferedPromptSuggestion({ ...idle, snapshot: newer } as never),
        ).toBeUndefined();
    });
});
