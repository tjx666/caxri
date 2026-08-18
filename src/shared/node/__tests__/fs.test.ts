import { constants } from 'node:fs';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isAccessible, isExistingPath } from '../fs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

async function createTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-shared-fs-'));
    temporaryDirectories.push(directory);
    return directory;
}

describe('isExistingPath', () => {
    it('reports files, directories, and dangling symlinks as existing', async () => {
        const directory = await createTemporaryDirectory();
        const file = join(directory, 'file.txt');
        await writeFile(file, 'content');
        const dangling = join(directory, 'dangling');
        await symlink(join(directory, 'missing-target'), dangling);

        await expect(isExistingPath(file)).resolves.toBe(true);
        await expect(isExistingPath(directory)).resolves.toBe(true);
        await expect(isExistingPath(dangling)).resolves.toBe(true);
        await expect(isExistingPath(join(directory, 'missing'))).resolves.toBe(false);
    });

    it('propagates non-ENOENT failures instead of reading them as absence', async () => {
        await expect(isExistingPath('\0invalid')).rejects.toThrow();
    });
});

describe('isAccessible', () => {
    it('checks the requested access mode and swallows every failure as false', async () => {
        const directory = await createTemporaryDirectory();
        const script = join(directory, 'script.sh');
        await writeFile(script, '#!/bin/sh\n');
        await chmod(script, 0o600);

        await expect(isAccessible(script)).resolves.toBe(true);
        await expect(isAccessible(script, constants.R_OK)).resolves.toBe(true);
        await expect(isAccessible(script, constants.X_OK)).resolves.toBe(false);
        await expect(isAccessible(join(directory, 'missing'))).resolves.toBe(false);
        await expect(isAccessible('\0invalid')).resolves.toBe(false);
    });
});
