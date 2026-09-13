import { CaxriError } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { describeThemeImportFailure } from '../theme-import-error';

describe('describeThemeImportFailure', () => {
    it('names the failing color roles and measured contrast from Server details', () => {
        const error = new CaxriError('VALIDATION', 'Contrast failed', {
            kind: 'theme-contrast',
            foregroundRole: 'muted',
            backgroundRole: 'surface',
            actualRatio: 1.234,
            requiredRatio: 4.5,
        });

        expect(describeThemeImportFailure(error)).toBe(
            'Theme import failed. --muted has 1.23:1 contrast against --surface; at least 4.5:1 is required.',
        );
    });

    it('falls back safely when validation details do not match the theme contrast contract', () => {
        const error = new CaxriError('VALIDATION', 'An imported theme is invalid', {
            kind: 'theme-contrast',
            foregroundRole: '../../private',
            backgroundRole: 'surface',
            actualRatio: 1,
            requiredRatio: 4.5,
        });

        expect(describeThemeImportFailure(error)).toBe(
            'Theme import failed. An imported theme is invalid.',
        );
    });
});
