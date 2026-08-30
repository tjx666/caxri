import { describe, expect, it } from 'vitest';

import { fileSearchResultSchema } from '../file-search';

function result(overrides: Record<string, unknown> = {}) {
    return {
        mode: 'content',
        matches: [],
        scannedFiles: 12,
        truncated: false,
        canceled: false,
        terminationReason: 'completed',
        ...overrides,
    };
}

describe('fileSearchResultSchema', () => {
    it('distinguishes completed, canceled, and bounded searches', () => {
        expect(fileSearchResultSchema.safeParse(result()).success).toBe(true);
        expect(
            fileSearchResultSchema.safeParse(
                result({ canceled: true, terminationReason: 'canceled' }),
            ).success,
        ).toBe(true);
        expect(
            fileSearchResultSchema.safeParse(
                result({ truncated: true, terminationReason: 'timeout' }),
            ).success,
        ).toBe(true);
    });

    it('rejects contradictory legacy flags', () => {
        expect(
            fileSearchResultSchema.safeParse(result({ terminationReason: 'timeout' })).success,
        ).toBe(false);
        expect(
            fileSearchResultSchema.safeParse(
                result({ canceled: true, matches: [{ path: '/tmp/a', relativePath: 'a' }] }),
            ).success,
        ).toBe(false);
    });
});
