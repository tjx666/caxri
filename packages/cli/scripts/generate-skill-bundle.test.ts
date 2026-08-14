import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeFileIfChanged } from './generate-skill-bundle';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe('skill bundle generation', () => {
    it('does not refresh the generated source mtime when content is unchanged', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-skill-bundle-'));
        temporaryDirectories.push(root);
        const path = join(root, 'generated.ts');
        const timestamp = new Date('2026-01-01T00:00:00.000Z');
        await writeFile(path, 'same\n', 'utf8');
        await utimes(path, timestamp, timestamp);

        await expect(writeFileIfChanged(path, 'same\n')).resolves.toBe(false);
        expect((await stat(path)).mtimeMs).toBe(timestamp.getTime());
        await expect(writeFileIfChanged(path, 'changed\n')).resolves.toBe(true);
        expect(await readFile(path, 'utf8')).toBe('changed\n');
    });
});
