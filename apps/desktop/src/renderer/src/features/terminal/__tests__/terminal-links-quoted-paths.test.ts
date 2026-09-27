import { describe, expect, it } from 'vitest';

import { findTerminalLinks } from '../terminal-links';

/**
 * Word tokenization splits at every whitespace character, so a path containing a space can only be recovered from the
 * quotes an Agent or a shell already printed around it. The long-paste receipt (`Original file: "…"`) is the product's
 * own output and always carries such a path on macOS (`~/Library/Application Support/…`).
 */
describe('findTerminalLinks quoted paths', () => {
    const path = '/Users/me/Library/Application Support/Caxri/pastes/paste-a1b2c3.txt';

    it('extracts a double-quoted absolute path that contains spaces', () => {
        const prefix = 'Original file: "';

        expect(findTerminalLinks(`${prefix}${path}"`)).toEqual([
            {
                endIndex: prefix.length + path.length,
                kind: 'file',
                startIndex: prefix.length,
                target: path,
                text: path,
            },
        ]);
    });

    it.each(["'", '`'])('extracts a path wrapped in %s', (quote) => {
        expect(findTerminalLinks(`saved to ${quote}${path}${quote} now`)).toMatchObject([
            { kind: 'file', target: path, text: path },
        ]);
    });

    it('keeps a location suffix attached to a quoted path with spaces', () => {
        expect(findTerminalLinks('at "/Users/me/My Notes/a.ts:42:7"')).toMatchObject([
            {
                kind: 'file',
                location: { mode: 'caret', line: 42, column: 7 },
                target: '/Users/me/My Notes/a.ts',
            },
        ]);
    });

    it.each(['~/My Notes/a.md', './my notes/a.md', '../my notes/a.md', 'file:///a b/c.ts'])(
        'accepts the explicit path marker in %s',
        (candidate) => {
            expect(findTerminalLinks(`open "${candidate}"`)).toMatchObject([
                { kind: 'file', text: candidate },
            ]);
        },
    );

    it('reports a quoted path with spaces once, without a fragment duplicate', () => {
        expect(findTerminalLinks(`"${path}" and "${path}"`)).toMatchObject([
            { kind: 'file', target: path },
            { kind: 'file', target: path },
        ]);
    });

    it('leaves quoted prose without an explicit path marker alone', () => {
        expect(
            findTerminalLinks('error: "could not find module in src/app" while linking'),
        ).toMatchObject([{ kind: 'file', target: 'src/app' }]);
    });

    it('does not link a quoted sentence that merely ends in an extension', () => {
        expect(findTerminalLinks('warning: "no such file or directory"')).toEqual([]);
    });

    it('keeps a quoted path without spaces on the existing token path', () => {
        expect(findTerminalLinks('open "/repo/src/a.ts" now')).toEqual([
            {
                endIndex: 20,
                kind: 'file',
                startIndex: 6,
                target: '/repo/src/a.ts',
                text: '/repo/src/a.ts',
            },
        ]);
    });

    it('leaves an unterminated quote on the existing fragment behavior', () => {
        expect(findTerminalLinks('Original file: "/Users/me/My Notes/a.md')).toMatchObject([
            { kind: 'file', target: '/Users/me/My' },
            { kind: 'file', target: 'Notes/a.md' },
        ]);
    });

    it('keeps a path quoted after a prose apostrophe', () => {
        expect(findTerminalLinks(`can't open '/Users/me/My Notes/a.md'`)).toMatchObject([
            { kind: 'file', target: '/Users/me/My Notes/a.md' },
        ]);
    });

    it('keeps an apostrophe that belongs to a double-quoted folder name', () => {
        expect(findTerminalLinks(`Original file: "/Users/me/Bob's Notes/paste.txt"`)).toMatchObject(
            [{ kind: 'file', target: `/Users/me/Bob's Notes/paste.txt` }],
        );
    });

    it('keeps the executable link when a quoted span is a command line', () => {
        expect(
            findTerminalLinks('error: failed to run "/usr/bin/env node --version"'),
        ).toMatchObject([{ kind: 'file', target: '/usr/bin/env' }]);
    });

    // Regression for issue #1022: the closing argument `index.js` carries no option flag and ends in an
    // extension, so the old shape rule (closing segment must have `/` or `.`) let the whole command line through
    // and suppressed the correct `/usr/bin/env` link.
    it('keeps only the executable link when a quoted command line ends in a bare file argument', () => {
        expect(
            findTerminalLinks('error: failed to run "/usr/bin/env node index.js"'),
        ).toMatchObject([{ kind: 'file', target: '/usr/bin/env' }]);
    });

    it('still links the full quoted path with spaces from issue #1007', () => {
        const original = '/Users/me/Library/Application Support/Caxri/pastes/paste-a1b2c3.txt';
        expect(findTerminalLinks(`Original file: "${original}"`)).toMatchObject([
            { kind: 'file', target: original, text: original },
        ]);
    });

    it.each([
        'error: "/repo/src/a.ts 已被删除，请重新生成"',
        'hint: "/repo/src/a.ts and try again"',
    ])('keeps only the path when quoted prose follows it in %s', (line) => {
        expect(findTerminalLinks(line)).toMatchObject([{ kind: 'file', target: '/repo/src/a.ts' }]);
    });

    it('cuts a full-width note glued to a quoted path with spaces', () => {
        expect(findTerminalLinks('见 "/Users/me/My Notes/a.md（旧版）"')).toMatchObject([
            { kind: 'file', target: '/Users/me/My Notes/a.md' },
        ]);
    });

    it('keeps a quoted URL on the URL path', () => {
        expect(findTerminalLinks('see "https://example.com/a b" here')).toMatchObject([
            { kind: 'url', target: 'https://example.com/a' },
        ]);
    });
});
