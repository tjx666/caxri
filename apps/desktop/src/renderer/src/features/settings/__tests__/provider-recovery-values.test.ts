import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { parseRecoveryDelay, parseRecoveryPatterns } from '../provider-recovery-values';

describe('parseRecoveryPatterns', () => {
    it('trims blank lines and removes case-insensitive duplicates', () => {
        expect(
            parseRecoveryPatterns(translate, ' API timeout \n\napi TIMEOUT\n retry failed '),
        ).toEqual({
            ok: true,
            patterns: ['API timeout', 'retry failed'],
        });
    });

    it('rejects an oversized pattern set without truncating user input', () => {
        const source = Array.from({ length: 21 }, (_, index) => `failure-${index}`).join('\n');
        expect(parseRecoveryPatterns(translate, source)).toEqual({
            ok: false,
            error: 'Add at most 20 patterns.',
        });
    });
});

describe('parseRecoveryDelay', () => {
    it('accepts only bounded integer millisecond values', () => {
        expect(parseRecoveryDelay('250')).toBe(250);
        expect(parseRecoveryDelay('10000')).toBe(10_000);
        expect(parseRecoveryDelay('249')).toBeUndefined();
        expect(parseRecoveryDelay('250.5')).toBeUndefined();
    });
});
