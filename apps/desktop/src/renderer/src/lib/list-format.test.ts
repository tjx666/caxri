import { describe, expect, it } from 'vitest';

import { formatList } from './list-format';

describe('formatList', () => {
    it('joins with the locale conjunction', () => {
        expect(formatList(['a', 'b', 'c'], 'en')).toBe('a, b, and c');
        expect(formatList(['a', 'b'], 'en')).toBe('a and b');
        expect(formatList(['a', 'b', 'c'], 'zh-CN')).toBe('a、b和c');
    });

    it('returns a single item unchanged', () => {
        expect(formatList(['a'], 'en')).toBe('a');
        expect(formatList([], 'en')).toBe('');
    });
});
