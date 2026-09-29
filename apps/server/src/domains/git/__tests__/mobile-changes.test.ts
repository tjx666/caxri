import { Buffer } from 'node:buffer';

import { MOBILE_GATEWAY_MAX_PLAINTEXT_BYTES } from '@caxri/mobile-transport';
import type { GitSummary } from '@caxri/protocol';
import { mobileChangesListResultSchema } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { mobileChangesListForSummary } from '../mobile-changes';

describe('mobile changes bounds', () => {
    it('lists per-file line counts from the status snapshot and adds new-file lines to the totals', () => {
        const summary = {
            isRepository: true,
            repositories: [
                {
                    id: 'repository-fixture',
                    name: 'Fixture',
                    rootPath: '/tmp/mobile-changes-fixture',
                    head: 'a'.repeat(40),
                    additions: 5,
                    deletions: 2,
                    changedFileCount: 2,
                    truncated: false,
                    files: [
                        { path: 'tracked.txt', kind: 'modified', additions: 5, deletions: 2 },
                        { path: 'new.txt', kind: 'untracked', additions: 3, deletions: 0 },
                    ],
                },
            ],
        } as unknown as GitSummary;
        const result = mobileChangesListForSummary(summary);
        expect(
            result.files.map(({ path, additions, deletions }) => [path, additions, deletions]),
        ).toEqual([
            ['tracked.txt', 5, 2],
            ['new.txt', 3, 0],
        ]);
        expect(result).toMatchObject({ additions: 8, deletions: 2 });
    });

    it('truncates a large metadata list below one sealed reply frame without exposing roots', () => {
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
        const result = mobileChangesListForSummary(summary);
        expect(mobileChangesListResultSchema.parse(result)).toEqual(result);
        expect(result.total).toBe(100);
        expect(result.truncated).toBe(true);
        expect(result.files.length).toBeLessThan(100);
        const wire = JSON.stringify({ type: 'reply', reply: { id: 'request-fixture', result } });
        expect(Buffer.byteLength(wire, 'utf8')).toBeLessThan(MOBILE_GATEWAY_MAX_PLAINTEXT_BYTES);
        expect(wire).not.toContain(rootPath);
    });
});
