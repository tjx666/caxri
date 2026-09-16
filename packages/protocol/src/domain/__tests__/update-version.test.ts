import { describe, expect, it } from 'vitest';

import { compareStableVersions, isUpdateVersionSkipped } from '../update-version.js';

describe('compareStableVersions', () => {
    it('orders Caxri release versions without a dependency on prerelease semantics', () => {
        expect(compareStableVersions('0.0.3', '0.0.4')).toBe(-1);
        expect(compareStableVersions('1.2.0', '1.1.9')).toBe(1);
        expect(compareStableVersions('v2.0.0', '2.0.0')).toBe(0);
        expect(() => compareStableVersions('2.0.0-beta.1', '2.0.0')).toThrow('unsupported version');
    });
});

describe('isUpdateVersionSkipped', () => {
    it('is inert until the user skips something', () => {
        expect(isUpdateVersionSkipped('1.1.0', null)).toBe(false);
        expect(isUpdateVersionSkipped('1.1.0', undefined)).toBe(false);
        expect(isUpdateVersionSkipped('1.1.0', '')).toBe(false);
    });

    it('covers the skipped version and anything it is newer than', () => {
        expect(isUpdateVersionSkipped('1.1.0', '1.1.0')).toBe(true);
        expect(isUpdateVersionSkipped('1.0.9', '1.1.0')).toBe(true);
    });

    it('stops covering a release newer than the skipped one', () => {
        expect(isUpdateVersionSkipped('1.1.1', '1.1.0')).toBe(false);
        expect(isUpdateVersionSkipped('2.0.0', '1.9.9')).toBe(false);
    });

    it('falls back to exact matching for a hand-edited value it cannot parse', () => {
        expect(isUpdateVersionSkipped('1.1.0', 'whatever')).toBe(false);
        expect(isUpdateVersionSkipped('whatever', 'whatever')).toBe(true);
    });
});
