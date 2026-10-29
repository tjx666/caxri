import { describe, expect, it } from 'vitest';

import { applyFormEdit, bytesToMebibytes, formatByteHint, mebibytesToBytes } from '../config-edit';

describe('applyFormEdit', () => {
    it('preserves comments and unrelated formatting when changing a flat key', () => {
        const source = [
            '{',
            '  // Keep the terminal roomy on my 4K display.',
            '  "terminal.fontSize": 13,',
            '  "terminal.scrollback": 2000,',
            '}',
            '',
        ].join('\n');

        const next = applyFormEdit(source, ['terminal.fontSize'], 16);

        expect(next).toBe(
            [
                '{',
                '  // Keep the terminal roomy on my 4K display.',
                '  "terminal.fontSize": 16,',
                '  "terminal.scrollback": 2000,',
                '}',
                '',
            ].join('\n'),
        );
        expect(next).toContain('// Keep the terminal roomy on my 4K display.');
    });

    it('edits one array item field by index path without disturbing sibling comments', () => {
        const source = [
            '[',
            '  // Save early, save often.',
            '  { "key": "mod+s", "command": "editor.save" },',
            '  { "key": "mod+p", "command": "palette.open" }',
            ']',
            '',
        ].join('\n');

        const next = applyFormEdit(source, [0, 'key'], 'mod+shift+s');

        expect(next).toContain('// Save early, save often.');
        expect(next).toContain('"key": "mod+shift+s"');
        expect(next).toContain('"command": "editor.save"');
        expect(next).toContain('"key": "mod+p"');
    });

    it('edits a nested path for theme color updates', () => {
        const source = '{\n  "colors": {\n    "accent": "#ff79c6"\n  }\n}\n';

        const next = applyFormEdit(source, ['colors', 'accent'], '#00ff00');

        expect(next).toContain('"accent": "#00ff00"');
    });
});

describe('byte/MB conversion', () => {
    it('round-trips clean megabyte values', () => {
        expect(bytesToMebibytes(2 * 1024 * 1024)).toBe(2);
        expect(mebibytesToBytes(2)).toBe(2 * 1024 * 1024);
    });

    it('rounds the schema minimum to bytes without drifting', () => {
        expect(mebibytesToBytes(bytesToMebibytes(1024))).toBe(1024);
    });

    it('formats the size hint in human units instead of raw bytes', () => {
        expect(formatByteHint(2097152, 'en')).toBe('2 MB');
        expect(formatByteHint(1572864, 'en')).toBe('1.5 MB');
    });
});
