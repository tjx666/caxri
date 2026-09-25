import { Buffer } from 'node:buffer';

import { MOBILE_GATEWAY_MAX_PLAINTEXT_BYTES } from '@caxri/mobile-transport';
import type { GitSummary } from '@caxri/protocol';
import { mobileChangesListResultSchema } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { mobileChangesListForSummary, parseMobileNumstat } from '../mobile-changes';

describe('mobile changes bounds', () => {
    it('parses NUL-delimited tracked line counts', () => {
        expect([...parseMobileNumstat('2\t1\tmodified.txt\0-\t-\tbinary.bin\0')]).toEqual([
            ['modified.txt', { additions: 2, deletions: 1 }],
            ['binary.bin', { additions: 0, deletions: 0 }],
        ]);
    });

    it('truncates a large metadata list below one sealed reply frame without exposing roots', async () => {
        const rootPath = '/tmp/mobile-changes-fixture';
        const summary = {
            isRepository: true,
            repositories: [
                {
                    id: 'repository-fixture',
                    name: 'Fixture',
                    rootPath,
                    head: 'a'.repeat(40),
                    additions: 0,
                    deletions: 0,
                    changedFileCount: 100,
                    truncated: false,
                    files: Array.from({ length: 100 }, (_, index) => ({
                        path: `directory/${index}/${'x'.repeat(1_000)}`,
                        kind: 'modified',
                    })),
                },
            ],
        } as unknown as GitSummary;
        const result = await mobileChangesListForSummary(summary, () => Promise.resolve(''));
        expect(mobileChangesListResultSchema.parse(result)).toEqual(result);
        expect(result.total).toBe(100);
        expect(result.truncated).toBe(true);
        expect(result.files.length).toBeLessThan(100);
        const wire = JSON.stringify({ type: 'reply', reply: { id: 'request-fixture', result } });
        expect(Buffer.byteLength(wire, 'utf8')).toBeLessThan(MOBILE_GATEWAY_MAX_PLAINTEXT_BYTES);
        expect(wire).not.toContain(rootPath);
    });
});
