import { agentChatSessionHandoffText } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    conversationActionText,
    conversationUserText,
    conversationUserTextRuns,
} from '../conversation-user-text';

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
        expect(conversationUserText('hello')).toEqual({
            kind: 'plain',
            runs: [{ kind: 'text', text: 'hello' }],
            text: 'hello',
        });
    });
});

describe('conversationUserTextRuns', () => {
    it('links a pasted URL without swallowing the words after it', () => {
        expect(conversationUserTextRuns('https://github.com/acme/app/pull/12 合了')).toEqual([
            {
                kind: 'url',
                text: 'https://github.com/acme/app/pull/12',
                url: 'https://github.com/acme/app/pull/12',
            },
            { kind: 'text', text: ' 合了' },
        ]);
    });

    it('splits text around every URL in order', () => {
        expect(conversationUserTextRuns('see https://a.dev and https://b.dev/x.')).toEqual([
            { kind: 'text', text: 'see ' },
            { kind: 'url', text: 'https://a.dev', url: 'https://a.dev' },
            { kind: 'text', text: ' and ' },
            { kind: 'url', text: 'https://b.dev/x', url: 'https://b.dev/x' },
            { kind: 'text', text: '.' },
        ]);
    });

    it('leaves bare domains and email addresses as words, as a reply does', () => {
        expect(conversationUserTextRuns('mail me@acme.dev about acme.dev')).toEqual([
            { kind: 'text', text: 'mail me@acme.dev about acme.dev' },
        ]);
    });

    it('returns nothing for an empty message', () => {
        expect(conversationUserTextRuns('')).toEqual([]);
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
