import { describe, expect, it } from 'vitest';

import { relativeTime } from '../relative-time';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

describe('relativeTime', () => {
    it('describes sub-minute differences in seconds', () => {
        expect(relativeTime(NOW, NOW)).toBe('now');
        expect(relativeTime(NOW - 5_000, NOW)).toBe('5 seconds ago');
    });

    it('picks the largest matching unit for past timestamps', () => {
        expect(relativeTime(NOW - 90_000, NOW)).toBe('1 minute ago');
        expect(relativeTime(NOW - 3_600_000, NOW)).toBe('1 hour ago');
        expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2 days ago');
        expect(relativeTime(NOW - 40 * 86_400_000, NOW)).toBe('last month');
        expect(relativeTime(NOW - 400 * 86_400_000, NOW)).toBe('last year');
    });

    it('describes future timestamps', () => {
        expect(relativeTime(NOW + 3 * 3_600_000, NOW)).toBe('in 3 hours');
    });
});
