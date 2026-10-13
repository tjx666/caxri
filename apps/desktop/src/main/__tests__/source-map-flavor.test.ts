import { describe, expect, it } from 'vitest';

import { normalizeSourceMapFlavor, releaseDmgFileName } from '../source-map-flavor';

describe('source-map-flavor', () => {
    it('preserves omit and falls back to include for unknown build markers', () => {
        expect(normalizeSourceMapFlavor('omit')).toBe('omit');
        expect(normalizeSourceMapFlavor('include')).toBe('include');
        expect(normalizeSourceMapFlavor(undefined)).toBe('include');
        expect(normalizeSourceMapFlavor('unknown')).toBe('include');
    });

    it('keeps the debuggable artifact canonical and gives omit an unambiguous suffix', () => {
        expect(releaseDmgFileName('1.2.3', 'include')).toBe('Caxri-1.2.3-arm64.dmg');
        expect(releaseDmgFileName('1.2.3', 'omit')).toBe('Caxri-1.2.3-arm64-nosourcemap.dmg');
    });
});
