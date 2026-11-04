import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { KNOWN_FLAT_FAMILIES } from '../flat-family-baseline';
import { FLAT_FAMILY_THRESHOLD, scanFlatFamilies } from '../flat-family-scan';

const projectRoot = resolve(import.meta.dirname, '..', '..');

describe('flat family ratchet', async () => {
    const families = await scanFlatFamilies(projectRoot);
    const known = new Set(KNOWN_FLAT_FAMILIES);

    it('rejects a new flat filename family', () => {
        const added = [...families]
            .filter(([family, count]) => count >= FLAT_FAMILY_THRESHOLD && !known.has(family))
            .map(([family, count]) => `${family}* (${count} modules)`);
        expect(
            added,
            `move each family into its own directory (for example retry-claims.ts -> retry/claims.ts); see the source-layout skill`,
        ).toEqual([]);
    });

    it('drops a recorded family once it moved out or shrank', () => {
        const stale = KNOWN_FLAT_FAMILIES.filter(
            (family) => (families.get(family) ?? 0) < FLAT_FAMILY_THRESHOLD,
        );
        expect(stale, 'remove these from scripts/flat-family-baseline.ts').toEqual([]);
    });

    it('keeps the recorded list free of duplicates', () => {
        expect(known.size).toBe(KNOWN_FLAT_FAMILIES.length);
    });
});
