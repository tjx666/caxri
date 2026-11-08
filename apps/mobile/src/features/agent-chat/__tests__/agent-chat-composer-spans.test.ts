import { describe, expect, it } from 'vitest';

import { agentChatComposerSpans } from '../agent-chat-composer-spans';

const far = { end: 0, start: 0 };

const summary = (draft: string, selection = far) =>
    agentChatComposerSpans(draft, selection).map((span) => ({
        text: span.text,
        ...(span.isHidden && { isHidden: true }),
        ...(span.isImage && { isImage: true }),
        ...(span.inline.length > 0 && { inline: span.inline }),
        ...(span.line && { line: span.line }),
    }));

describe('agentChatComposerSpans', () => {
    it('keeps every character of the draft in order', () => {
        const draft = '# Plan\n- **bold** and `code`\n> quoted [Image #1]\n';
        const spans = agentChatComposerSpans(draft, far);
        expect(spans.map((span) => span.text).join('')).toBe(draft);
    });

    it('hides inline syntax away from the cursor and styles its content', () => {
        expect(summary('say **hi** now', { end: 14, start: 14 })).toEqual([
            { text: 'say ' },
            { isHidden: true, inline: ['strong'], text: '**' },
            { inline: ['strong'], text: 'hi' },
            { isHidden: true, inline: ['strong'], text: '**' },
            { text: ' now' },
        ]);
    });

    it('shows the syntax the cursor touches, dimmed', () => {
        expect(summary('say **hi** now', { end: 7, start: 7 })).toEqual([
            { text: 'say ' },
            { inline: ['strong', 'syntax'], text: '**' },
            { inline: ['strong'], text: 'hi' },
            { inline: ['strong', 'syntax'], text: '**' },
            { text: ' now' },
        ]);
    });

    it('styles a heading line and hides its mark until the cursor reaches the line', () => {
        expect(summary('# Plan\nnext', { end: 11, start: 11 })).toEqual([
            { isHidden: true, line: 'heading1', text: '# ' },
            { line: 'heading1', text: 'Plan' },
            { text: '\nnext' },
        ]);
        expect(summary('# Plan\nnext', { end: 3, start: 3 })).toEqual([
            { line: 'heading1', text: '# Plan' },
            { text: '\nnext' },
        ]);
    });

    it('dims a bullet marker and marks image placeholders', () => {
        expect(summary('- see [Image #2]', { end: 16, start: 16 })).toEqual([
            { inline: ['syntax'], line: 'list', text: '-' },
            { line: 'list', text: ' see ' },
            { isImage: true, line: 'list', text: '[Image #2]' },
        ]);
    });
});
