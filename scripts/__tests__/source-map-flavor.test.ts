import { describe, expect, it } from 'vitest';

import { resolveSourceMapFlavor, shouldIncludeSourceMaps } from '../source-map-flavor';

describe('source-map-flavor', () => {
    it('defaults to include only when the variable is absent', () => {
        expect(resolveSourceMapFlavor({})).toBe('include');
        expect(shouldIncludeSourceMaps(resolveSourceMapFlavor({}))).toBe(true);
    });

    it('accepts the two explicit build flavors', () => {
        expect(resolveSourceMapFlavor({ CAXRI_SOURCE_MAPS: 'include' })).toBe('include');
        expect(resolveSourceMapFlavor({ CAXRI_SOURCE_MAPS: 'omit' })).toBe('omit');
        expect(shouldIncludeSourceMaps(resolveSourceMapFlavor({ CAXRI_SOURCE_MAPS: 'omit' }))).toBe(
            false,
        );
    });

    it.each(['', 'true', 'false', 'Include', 'unknown'])(
        'fails closed for the explicit invalid value %j',
        (value) => {
            expect(() => resolveSourceMapFlavor({ CAXRI_SOURCE_MAPS: value })).toThrow(
                'CAXRI_SOURCE_MAPS must be "include" or "omit"',
            );
        },
    );
});
