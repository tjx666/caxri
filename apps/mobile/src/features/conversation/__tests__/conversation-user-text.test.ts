import { agentChatSessionHandoffText } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    conversationActionText,
    conversationUserListLine,
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
            blocks: [{ runs: [{ kind: 'text', styles: [], text: 'hello' }] }],
            text: 'hello',
        });
    });

    it('draws a quote behind its bar with the marker hidden, as Desktop does', () => {
        const user = conversationUserText('> 迁移给现有渠道\n\n这个是写了迁移脚本?');
        expect(user.kind === 'plain' ? user.blocks : []).toEqual([
            { line: 'quote', runs: [{ kind: 'text', styles: [], text: '迁移给现有渠道' }] },
            { runs: [{ kind: 'text', styles: [], text: '\n这个是写了迁移脚本?' }] },
        ]);
    });

    it('hides emphasis and code markers and keeps a link whole inside bold text', () => {
        const user = conversationUserText('**see https://a.dev** and `x`');
        expect(user.kind === 'plain' ? user.blocks : []).toEqual([
            {
                runs: [
                    { kind: 'text', styles: ['strong'], text: 'see ' },
                    {
                        kind: 'segment',
                        segment: {
                            kind: 'url',
                            from: 6,
                            text: 'https://a.dev',
                            url: 'https://a.dev',
                        },
                        styles: ['strong'],
                    },
                    { kind: 'text', styles: [], text: ' and ' },
                    { kind: 'text', styles: ['code'], text: 'x' },
                ],
            },
        ]);
    });
});

describe('conversationUserListLine', () => {
    it('splits a bullet line into its marker and the content that wraps after it', () => {
        const user = conversationUserText('- one two');
        const block = user.kind === 'plain' ? user.blocks[0] : undefined;
        expect(block && conversationUserListLine(block)).toEqual({
            marker: [{ kind: 'bullet' }, { kind: 'text', styles: [], text: ' ' }],
            content: [{ kind: 'text', styles: [], text: 'one two' }],
        });
    });

    it('keeps an ordered number in the marker', () => {
        const user = conversationUserText('12. first');
        const block = user.kind === 'plain' ? user.blocks[0] : undefined;
        expect(block && conversationUserListLine(block)).toEqual({
            marker: [
                { kind: 'text', styles: ['syntax'], text: '12.' },
                { kind: 'text', styles: [], text: ' ' },
            ],
            content: [{ kind: 'text', styles: [], text: 'first' }],
        });
    });
});

describe('conversationUserTextRuns', () => {
    it('links a pasted URL without swallowing the words after it', () => {
        expect(conversationUserTextRuns('https://github.com/acme/app/pull/12 合了')).toEqual([
            {
                kind: 'url',
                from: 0,
                text: 'https://github.com/acme/app/pull/12',
                url: 'https://github.com/acme/app/pull/12',
            },
            { kind: 'text', from: 35, text: ' 合了' },
        ]);
    });

    it('splits text around every URL in order', () => {
        expect(conversationUserTextRuns('see https://a.dev and https://b.dev/x.')).toEqual([
            { kind: 'text', from: 0, text: 'see ' },
            { kind: 'url', from: 4, text: 'https://a.dev', url: 'https://a.dev' },
            { kind: 'text', from: 17, text: ' and ' },
            { kind: 'url', from: 22, text: 'https://b.dev/x', url: 'https://b.dev/x' },
            { kind: 'text', from: 37, text: '.' },
        ]);
    });

    it('leaves bare domains and email addresses as words, as a reply does', () => {
        expect(conversationUserTextRuns('mail me@acme.dev about acme.dev')).toEqual([
            { kind: 'text', from: 0, text: 'mail me@acme.dev about acme.dev' },
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
