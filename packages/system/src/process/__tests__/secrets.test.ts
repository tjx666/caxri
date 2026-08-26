import { describe, expect, it } from 'vitest';

import { isSecretMatch } from '../secrets';

describe('isSecretMatch', () => {
    it('accepts equal values and rejects content and length mismatches', () => {
        expect(isSecretMatch('shared-secret', 'shared-secret')).toBe(true);
        expect(isSecretMatch('shared-secreu', 'shared-secret')).toBe(false);
        expect(isSecretMatch('short', 'a-much-longer-candidate-token')).toBe(false);
        expect(isSecretMatch('', 'shared-secret')).toBe(false);
    });
});
