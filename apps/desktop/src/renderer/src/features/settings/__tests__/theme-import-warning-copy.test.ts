import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n/translate';
import { themeImportWarningText } from '../theme-import-warning-copy';

describe('themeImportWarningText', () => {
    it('translates a known id and interpolates its params', () => {
        expect(
            themeImportWarningText(
                { id: 'terminal-palette-fallback', message: 'x', params: { preset: 'Dark+' } },
                translate,
            ),
        ).toContain('Dark+');
    });

    it('lists the missing syntax roles with plain words', () => {
        const text = themeImportWarningText(
            { id: 'missing-syntax-colors', message: 'x', params: { roles: 'comment,number' } },
            translate,
        );
        expect(text).toBe('Syntax colors for comments and numbers were not imported.');
    });

    it('says all syntax colors are missing when no roles are listed', () => {
        expect(
            themeImportWarningText({ id: 'missing-syntax-colors', message: 'x' }, translate),
        ).toBe('Syntax colors were not imported.');
    });

    it('falls back to the Server message for an unknown id', () => {
        expect(themeImportWarningText({ id: 'future', message: 'Fallback text' }, translate)).toBe(
            'Fallback text',
        );
    });
});
