import { describe, expect, it } from 'vitest';

import { TERMINAL_FONT_FAMILY, terminalFontFamily } from '../terminal-fonts';

describe('terminalFontFamily', () => {
    it('returns the bundled stack when the setting is unset or blank', () => {
        expect(terminalFontFamily(null)).toBe(TERMINAL_FONT_FAMILY);
        expect(terminalFontFamily(undefined)).toBe(TERMINAL_FONT_FAMILY);
        expect(terminalFontFamily(' '.repeat(3))).toBe(TERMINAL_FONT_FAMILY);
    });

    it('prepends a custom face ahead of the bundled fallback stack', () => {
        expect(terminalFontFamily('Menlo')).toBe(`Menlo, ${TERMINAL_FONT_FAMILY}`);
    });

    it('quotes bare names containing spaces', () => {
        expect(terminalFontFamily('JetBrains Mono')).toBe(
            `"JetBrains Mono", ${TERMINAL_FONT_FAMILY}`,
        );
    });

    it('passes through values that already carry quotes or a stack', () => {
        expect(terminalFontFamily('"Fira Code", monospace')).toBe(
            `"Fira Code", monospace, ${TERMINAL_FONT_FAMILY}`,
        );
    });
});
