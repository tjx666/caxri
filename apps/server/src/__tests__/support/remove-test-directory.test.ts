import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listResidualEntries, removeTestDirectory } from './remove-test-directory';

describe('test directory cleanup', () => {
    it('lists residual entries as relative paths without file contents', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-cleanup-helper-'));
        try {
            await mkdir(join(root, 'logs'));
            await writeFile(join(root, 'logs', 'late.jsonl'), 'secret');
            const entries = await listResidualEntries(root);
            expect(entries.toSorted((a, b) => a.localeCompare(b))).toEqual([
                'logs/',
                'logs/late.jsonl',
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('removes a directory tree', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-cleanup-helper-'));
        await mkdir(join(root, 'a'));
        await writeFile(join(root, 'a', 'b'), 'x');
        await removeTestDirectory(root);
        expect(await listResidualEntries(root)).toEqual([]);
    });
});
