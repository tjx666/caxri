import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { atomicWriteFile } from '../atomic-write-file';

const roots: string[] = [];

async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'atomic-write-'));
    roots.push(root);
    return root;
}

afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
    roots.length = 0;
});

describe('atomicWriteFile', () => {
    it.each(['durable', 'file', 'none'] as const)(
        'replaces content and leaves no temporary file (%s)',
        async (durability) => {
            const root = await createRoot();
            const path = join(root, 'nested', 'a.json');
            await atomicWriteFile(path, 'one', { durability });
            await atomicWriteFile(path, new TextEncoder().encode('two'), { durability });
            expect(await readFile(path, 'utf8')).toBe('two');
            expect(await readdir(join(root, 'nested'))).toEqual(['a.json']);
        },
    );

    it('applies the requested mode exactly when asked', async () => {
        const root = await createRoot();
        const path = join(root, 'run.sh');
        await atomicWriteFile(path, 'x', { durability: 'file', exactMode: true, mode: 0o755 });
        expect((await stat(path)).mode & 0o777).toBe(0o755);
        const secret = join(root, 'secret');
        await atomicWriteFile(secret, 'x', { durability: 'none' });
        expect((await stat(secret)).mode & 0o777).toBe(0o600);
    });

    it('removes the temporary file and keeps the original when the rename fails', async () => {
        const root = await createRoot();
        const path = join(root, 'target');
        await mkdir(path);
        await writeFile(join(path, 'keep'), 'x');
        await expect(atomicWriteFile(path, 'data', { durability: 'durable' })).rejects.toThrow();
        expect(await readdir(root)).toEqual(['target']);
    });

    it('fails without clobbering when the temporary path already exists', async () => {
        const root = await createRoot();
        const path = join(root, 'a');
        const temporaryPath = join(root, 'a.tmp');
        await writeFile(temporaryPath, 'other writer');
        await expect(
            atomicWriteFile(path, 'x', { durability: 'none', temporaryPath }),
        ).rejects.toThrow();
        await expect(stat(path)).rejects.toThrow();
        expect(await readFile(temporaryPath, 'utf8')).toBe('other writer');
    });
});
