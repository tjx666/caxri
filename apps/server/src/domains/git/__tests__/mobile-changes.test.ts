import { Buffer } from 'node:buffer';

import { MOBILE_GATEWAY_MAX_PLAINTEXT_BYTES } from '@caxri/mobile-transport';
import type { GitSummary } from '@caxri/protocol';
import { mobileChangesListResultSchema } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { readBoundedRegularFile } from '../../bounded-file-reader';
import { mobileChangesListForSummary, parseMobileNumstat } from '../mobile-changes';

vi.mock('node:fs/promises', () => ({ lstat: () => Promise.resolve({ isFile: () => true }) }));
vi.mock('../../bounded-file-reader', () => ({ readBoundedRegularFile: vi.fn() }));

describe('mobile changes bounds', () => {
    it('shares a file-read budget across concurrent mobile Changes requests', async () => {
        let active = 0;
        let peak = 0;
        vi.mocked(readBoundedRegularFile).mockImplementation(async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise<void>((resolve) => setImmediate(resolve));
            active -= 1;
            return Buffer.from('fixture\n');
        });
        const summary = {
            isRepository: true,
            repositories: [
                {
                    id: 'repository-fixture',
                    name: 'Fixture',
                    rootPath: '/tmp/mobile-changes-fixture',
                    head: 'a'.repeat(40),
                    additions: 0,
                    deletions: 0,
                    changedFileCount: 100,
                    truncated: false,
                    files: Array.from({ length: 100 }, (_, index) => ({
                        path: `file-${index}.txt`,
                        kind: 'untracked',
                    })),
                },
            ],
        } as unknown as GitSummary;
        const git = () => Promise.resolve('');
        const results = await Promise.all([
            mobileChangesListForSummary(summary, git),
            mobileChangesListForSummary(summary, git),
        ]);
        expect(results.map((result) => result.additions)).toEqual([100, 100]);
        expect(peak).toBeLessThanOrEqual(8);
        expect(active).toBe(0);
    });

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
