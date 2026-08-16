// eslint-disable-next-line unicorn/name-replacements -- the test basename must mirror its source module `configuration-contract.ts`
import { describe, expect, it } from 'vitest';

import {
    configurationSourceSchema as configSourceSchema,
    MAX_CONFIGURATION_SOURCE_BYTES,
} from '../configuration-contract';

describe('configurationSourceSchema', () => {
    it('accepts a source at or under the UTF-8 byte ceiling', () => {
        const atLimit = 'a'.repeat(MAX_CONFIGURATION_SOURCE_BYTES);
        expect(configSourceSchema.safeParse(atLimit).success).toBe(true);
    });

    it('rejects a source over the UTF-8 byte ceiling even when JS string length is smaller', () => {
        // Each multi-byte character costs more UTF-8 bytes than UTF-16 code units, so a string whose
        // .length is well under the limit can still exceed the wire byte ceiling.
        const multiByteChar = '\u{1F600}'; // 4 UTF-8 bytes, 2 UTF-16 code units
        const count = Math.floor(MAX_CONFIGURATION_SOURCE_BYTES / 2) - 10;
        const oversized = multiByteChar.repeat(count);
        expect(oversized.length).toBeLessThan(MAX_CONFIGURATION_SOURCE_BYTES);
        expect(configSourceSchema.safeParse(oversized).success).toBe(false);
    });

    it('rejects a plain ASCII source one byte over the ceiling', () => {
        const oversized = 'a'.repeat(MAX_CONFIGURATION_SOURCE_BYTES + 1);
        expect(configSourceSchema.safeParse(oversized).success).toBe(false);
    });
});
