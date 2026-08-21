import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeJsonAtomic } from '../atomic-json';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-atomic-json-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    const directories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

describe('atomic JSON writer', () => {
    it('publishes formatted JSON through a private synced replacement', async () => {
        const directory = await createTemporaryDirectory();
        const path = join(directory, 'nested', 'state.json');

        await writeJsonAtomic(path, { ready: true }, { ensureParent: true, mode: 0o600 });

        expect(await readFile(path, 'utf8')).toBe('{\n  "ready": true\n}\n');
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(await readdir(join(directory, 'nested'))).toEqual(['state.json']);
    });

    it('retains the destination and removes the temporary file when publication fails', async () => {
        const directory = await createTemporaryDirectory();
        const path = join(directory, 'state.json');
        await writeFile(path, 'original\n', 'utf8');

        await expect(
            writeJsonAtomic(
                path,
                { ready: true },
                {
                    beforeRename: () => {
                        throw new Error('publication rejected');
                    },
                },
            ),
        ).rejects.toThrow('publication rejected');

        expect(await readFile(path, 'utf8')).toBe('original\n');
        expect(await readdir(directory)).toEqual([basename(path)]);
    });

    it('rejects a temporary file replaced before publication', async () => {
        const directory = await createTemporaryDirectory();
        const path = join(directory, 'state.json');
        await writeFile(path, 'original\n', 'utf8');

        await expect(
            writeJsonAtomic(
                path,
                { ready: true },
                {
                    beforeRename: async (temporary) => {
                        await rm(temporary);
                        await writeFile(temporary, 'forged\n', 'utf8');
                    },
                },
            ),
        ).rejects.toThrow('temporary file identity changed before rename');

        expect(await readFile(path, 'utf8')).toBe('original\n');
        expect(await readdir(directory)).toEqual([basename(path)]);
    });
});
