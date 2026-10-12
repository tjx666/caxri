import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { humanizeThemeTokenLabel } from '../theme-token-labels';

describe('humanizeThemeTokenLabel', () => {
    it('uses the curated map for known theme token keys', () => {
        expect(humanizeThemeTokenLabel(translate, 'selectionBackground')).toBe(
            'Selection background',
        );
        expect(humanizeThemeTokenLabel(translate, 'brightMagenta')).toBe('Bright magenta');
        expect(humanizeThemeTokenLabel(translate, 'lineHighlight')).toBe('Line highlight');
        expect(humanizeThemeTokenLabel(translate, 'background')).toBe('Background');
    });

    it('falls back to a camelCase-to-sentence-case splitter for unmapped keys', () => {
        expect(humanizeThemeTokenLabel(translate, 'someFutureToken')).toBe('Some future token');
        expect(humanizeThemeTokenLabel(translate, 'abcXYZDef')).toBe('Abc xyz def');
    });

    it('returns the key unchanged when it has no case boundaries and is unmapped', () => {
        expect(humanizeThemeTokenLabel(translate, 'unmappedkey')).toBe('Unmappedkey');
    });
});
