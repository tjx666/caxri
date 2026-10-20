import { describe, expect, it } from 'vitest';

import {
    agentChatMarkdownMarks,
    isAgentChatEmphasisIntentional,
} from '../agent-chat-composer-markdown';

/**
 * The marks for a draft with the caret at `|` (or none, for an unfocused editor), each written as its kind, style, and
 * the text it covers, in document order.
 */
function marks(marked: string): string[] {
    const caret = marked.indexOf('|');
    const text = marked.replace('|', '');
    const selection = caret === -1 ? [] : [{ from: caret, to: caret }];
    return agentChatMarkdownMarks(text, selection)
        .toSorted((a, b) => a.from - b.from)
        .map((mark) => {
            if (mark.kind === 'line') {
                const end = text.indexOf('\n', mark.from);
                const line = text.slice(mark.from, end === -1 ? undefined : end);
                return `line:${mark.style}${mark.indent ? `:${mark.indent}` : ''} ${line}`;
            }
            const covered = text.slice(mark.from, mark.to);
            return mark.kind === 'text'
                ? `text:${mark.style} ${covered}`
                : `${mark.kind} ${covered}`;
        });
}

describe('agentChatMarkdownMarks', () => {
    it('renders bold, italics, inline code, and strikethrough with their markers hidden', () => {
        expect(marks('a **b** *c* `d` ~~e~~')).toEqual([
            'text:strong **b**',
            'hide **',
            'hide **',
            'text:emphasis *c*',
            'hide *',
            'hide *',
            'text:code `d`',
            'hide `',
            'hide `',
            'text:strike ~~e~~',
            'hide ~~',
            'hide ~~',
        ]);
    });

    it('shows the markers of the element the caret touches', () => {
        expect(marks('**b**| *c*')).toEqual([
            'text:strong **b**',
            'text:syntax **',
            'text:syntax **',
            'text:emphasis *c*',
            'hide *',
            'hide *',
        ]);
    });

    it('leaves snake_case names as typed', () => {
        expect(marks('open src/my_file_name.ts')).toEqual([]);
    });

    it('sizes a heading and hides its mark unless the caret is on its line', () => {
        expect(marks('# Title\n\ntext')).toEqual(['line:heading1 # Title', 'hide # ']);
        expect(marks('## Ti|tle')).toEqual(['line:heading2 ## Title']);
    });

    it('draws bullets and hangs wrapped list text after the marker', () => {
        expect(marks('- one\n  * two\n\n3. three')).toEqual([
            'line:list:2 - one',
            'bullet -',
            'line:list:4   * two',
            'bullet *',
            'line:list:3 3. three',
            'text:syntax 3.',
        ]);
    });

    it('shows the bullet the caret is at', () => {
        expect(marks('-| one')).toEqual(['line:list:2 - one', 'text:syntax -']);
    });

    it('styles a quote and hides its marker off the caret line', () => {
        expect(marks('> said')).toEqual(['line:quote > said', 'hide > ']);
        expect(marks('> sa|id')).toEqual(['line:quote > said']);
    });

    it('styles fenced code without rendering Markdown inside it', () => {
        expect(marks('```ts\nconst **a** = 1;\n```')).toEqual([
            'line:fence ```ts',
            'line:code const **a** = 1;',
            'line:fence ```',
        ]);
    });

    it('treats the last line of an unclosed fence as code', () => {
        expect(marks('```\ncode')).toEqual(['line:fence ```', 'line:code code']);
    });
});

describe('isAgentChatEmphasisIntentional', () => {
    const isIntentional = (text: string, from = 0, to = text.length): boolean =>
        isAgentChatEmphasisIntentional(text, from, to);

    it('accepts ordinary emphasis', () => {
        expect(isIntentional('**bold**')).toBe(true);
        expect(isIntentional('*it*')).toBe(true);
        expect(isIntentional('a **b** c', 2, 7)).toBe(true);
    });

    it('rejects emphasis made of path characters', () => {
        expect(isIntentional('src/*.ts and lib/*.ts', 4, 18)).toBe(false);
        expect(isIntentional('__init__.py', 0, 8)).toBe(false);
        expect(isIntentional('*src/a.ts*')).toBe(false);
    });

    it('rejects intraword underscore emphasis', () => {
        expect(isIntentional('foo_bar_baz', 3, 8)).toBe(false);
    });

    it('rejects a double-underscore dunder name but keeps underscore emphasis around words', () => {
        expect(isIntentional('__init__')).toBe(false);
        expect(isIntentional('call __init__ now', 5, 13)).toBe(false);
        expect(isIntentional('__two words__')).toBe(true);
        expect(isIntentional('_it_')).toBe(true);
    });
});

describe('agentChatMarkdownMarks on path-like text', () => {
    it('keeps path and identifier text raw and unstyled', () => {
        expect(marks('src/*.ts and lib/*.ts')).toEqual([]);
        expect(marks('__init__.py')).toEqual([]);
        expect(marks('foo_bar_baz')).toEqual([]);
        expect(marks('and __init__ plus')).toEqual([]);
    });

    it('still renders real emphasis beside it', () => {
        expect(marks('a **b** c')).toEqual(['text:strong **b**', 'hide **', 'hide **']);
    });
});
