import { describe, expect, it } from 'vitest';

import { likeSubstringPattern } from '../like-pattern.js';

describe('likeSubstringPattern', () => {
    it('wraps plain text as a substring pattern', () => {
        expect(likeSubstringPattern('migration')).toBe('%migration%');
    });

    it('escapes the wildcards and the escape character', () => {
        expect(likeSubstringPattern(String.raw`100%_a\b`)).toBe(String.raw`%100\%\_a\\b%`);
    });
});
