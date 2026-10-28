import { agentChatSessionHandoffText } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { conversationActionText, conversationUserText } from '../conversation-user-text';

const handoff = (note: string): string =>
    agentChatSessionHandoffText({ note, projectId: 'project-1', provider: 'claude' });

describe('conversationUserText', () => {
    it('reads a hand-off as the note the user typed, not the instructions', () => {
        expect(conversationUserText(handoff('Fix the login bug'))).toEqual({
            kind: 'handoff',
            note: 'Fix the login bug',
        });
    });

    it('keeps an empty note so the card can say the Agent picks the next task', () => {
        expect(conversationUserText(handoff(''))).toEqual({ kind: 'handoff', note: '' });
    });

    it('leaves an ordinary message alone', () => {
        expect(conversationUserText('hello')).toEqual({ kind: 'plain', text: 'hello' });
    });
});

describe('conversationActionText', () => {
    it('copies the note of a hand-off and the command when there is none', () => {
        expect(conversationActionText(handoff('Fix the login bug'))).toBe('Fix the login bug');
        expect(conversationActionText(handoff(''))).toBe('/new-session');
    });

    it('returns an ordinary message unchanged', () => {
        expect(conversationActionText('hello')).toBe('hello');
    });
});
