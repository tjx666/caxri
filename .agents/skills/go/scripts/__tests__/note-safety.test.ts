import { describe, expect, it } from 'vitest';

import { MAX_NOTE_TEXT_CHARACTERS, sanitizeLedgerDetail, sanitizeNoteText } from '../note-safety';

describe('Go note safety', () => {
    it('trims and redacts secret-shaped note content', () => {
        expect(sanitizeNoteText('  probe token=private-value  ')).toEqual({
            redacted: true,
            text: 'probe token=[REDACTED]',
            truncated: false,
        });
    });

    it('rejects blank and oversized notes unless bounded truncation is requested', () => {
        expect(() => sanitizeNoteText(' '.repeat(3))).toThrow('Note text is required');
        expect(() => sanitizeNoteText('x'.repeat(MAX_NOTE_TEXT_CHARACTERS + 1))).toThrow(
            `Note text exceeds ${MAX_NOTE_TEXT_CHARACTERS} characters`,
        );
        expect(sanitizeNoteText(` ${'x'.repeat(MAX_NOTE_TEXT_CHARACTERS + 1)} `, true)).toEqual({
            redacted: false,
            text: 'x'.repeat(MAX_NOTE_TEXT_CHARACTERS),
            truncated: true,
        });
    });

    it('bounds ledger details after redaction', () => {
        const detail = `token=private-value ${'x'.repeat(MAX_NOTE_TEXT_CHARACTERS)}`;
        const sanitized = sanitizeLedgerDetail(detail);
        expect(sanitized).not.toContain('private-value');
        expect(sanitized).toHaveLength(MAX_NOTE_TEXT_CHARACTERS);
    });
});
