import { afterEach, describe, expect, it, vi } from 'vitest';

import { relativeTime } from '../relative-time';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

afterEach(() => {
    vi.unstubAllGlobals();
});

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

    it('abbreviates every unit in the narrow style', () => {
        expect(relativeTime(NOW - 5_000, NOW, 'narrow')).toBe('5s ago');
        expect(relativeTime(NOW - 8 * 60_000, NOW, 'narrow')).toBe('8m ago');
        expect(relativeTime(NOW - 3_600_000, NOW, 'narrow')).toBe('1h ago');
        expect(relativeTime(NOW - 3 * 86_400_000, NOW, 'narrow')).toBe('3d ago');
        expect(relativeTime(NOW + 3 * 3_600_000, NOW, 'narrow')).toBe('in 3h');
    });

    it('keeps the spelled-out numeric-auto wording, abbreviating only where Intl does', () => {
        expect(relativeTime(NOW, NOW, 'narrow')).toBe('now');
        expect(relativeTime(NOW - 86_400_000, NOW, 'narrow')).toBe('yesterday');
        expect(relativeTime(NOW - 40 * 86_400_000, NOW, 'narrow')).toBe('last mo.');
        expect(relativeTime(NOW - 400 * 86_400_000, NOW, 'narrow')).toBe('last yr.');
    });

    it('does not let one style leak into the other', () => {
        expect(relativeTime(NOW - 8 * 60_000, NOW, 'narrow')).toBe('8m ago');
        expect(relativeTime(NOW - 8 * 60_000, NOW)).toBe('8 minutes ago');
        expect(relativeTime(NOW - 8 * 60_000, NOW, 'narrow')).toBe('8m ago');
    });

    it('loads and formats when Intl.RelativeTimeFormat is unavailable', async () => {
        vi.resetModules();
        vi.stubGlobal('Intl', { ...Intl, RelativeTimeFormat: undefined });

        const portableModule = await import('../relative-time');

        expect(portableModule.relativeTime(NOW - 90_000, NOW)).toBe('1 minute ago');
        // The fallback carries the narrow style too, so a runtime without the formatter renders the same dense rows.
        expect(portableModule.relativeTime(NOW - 90_000, NOW, 'narrow')).toBe('1m ago');
        expect(portableModule.relativeTime(NOW - 3 * 3_600_000, NOW, 'narrow')).toBe('3h ago');
        expect(portableModule.relativeTime(NOW - 40 * 86_400_000, NOW, 'narrow')).toBe('last mo.');
        expect(portableModule.relativeTime(NOW - 86_400_000, NOW, 'narrow')).toBe('yesterday');
    });
});
