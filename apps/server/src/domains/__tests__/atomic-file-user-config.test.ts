import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    readlink,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { atomicWriteUserConfig } from '../atomic-file';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

async function makeTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-atomic-user-config-'));
    temporaryDirectories.push(directory);
    return directory;
}

async function strayTemporaryFiles(...directories: string[]): Promise<string[]> {
    const entries = await Promise.all(directories.map((directory) => readdir(directory)));
    return entries.flat().filter((name) => name.endsWith('.tmp'));
}

async function permissionBits(path: string): Promise<number> {
    return (await stat(path)).mode & 0o777;
}

describe('atomicWriteUserConfig', () => {
    it('replaces the canonical target of a symlinked config and keeps the link', async () => {
        const directory = await makeTemporaryDirectory();
        const home = join(directory, 'home');
        const dotfiles = join(directory, 'dotfiles');
        await Promise.all([mkdir(home), mkdir(dotfiles)]);
        const source = join(dotfiles, 'settings.json');
        const link = join(home, 'settings.json');
        await writeFile(source, '{}\n', 'utf8');
        // Group-writable bits a typical umask would strip from `open`'s mode prove the mode is reapplied exactly.
        await chmod(source, 0o664);
        await symlink(source, link);

        await atomicWriteUserConfig(link, '{"hooks":{}}\n');

        expect((await lstat(link)).isSymbolicLink()).toBe(true);
        expect(await readlink(link)).toBe(source);
        expect(await readFile(source, 'utf8')).toBe('{"hooks":{}}\n');
        expect(await permissionBits(source)).toBe(0o664);
        expect(await strayTemporaryFiles(home, dotfiles)).toEqual([]);
    });

    it('fails closed on a dangling symlink without replacing the link', async () => {
        const directory = await makeTemporaryDirectory();
        const missing = join(directory, 'dotfiles', 'settings.json');
        const link = join(directory, 'settings.json');
        await symlink(missing, link);

        await expect(atomicWriteUserConfig(link, '{}\n')).rejects.toMatchObject({
            code: 'CONFLICT',
            message:
                'settings.json is a symlink to a missing file. Restore the link target or remove the link.',
        });

        expect(await readlink(link)).toBe(missing);
        await expect(lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await strayTemporaryFiles(directory)).toEqual([]);
    });

    it('preserves the permission bits of an existing regular file', async () => {
        const directory = await makeTemporaryDirectory();
        const path = join(directory, 'hooks.json');
        await writeFile(path, '{}\n', 'utf8');
        await chmod(path, 0o644);

        await atomicWriteUserConfig(path, '{"hooks":{}}\n');

        expect(await readFile(path, 'utf8')).toBe('{"hooks":{}}\n');
        expect(await permissionBits(path)).toBe(0o644);
    });

    it('creates a missing config owner-only inside a new directory', async () => {
        const directory = await makeTemporaryDirectory();
        const path = join(directory, 'claude', 'settings.json');

        await atomicWriteUserConfig(path, '{}\n');

        expect(await readFile(path, 'utf8')).toBe('{}\n');
        expect(await permissionBits(path)).toBe(0o600);
    });

    it('rejects a symlink to a directory instead of renaming over it', async () => {
        const directory = await makeTemporaryDirectory();
        const target = join(directory, 'settings-directory');
        const link = join(directory, 'settings.json');
        await mkdir(target);
        await symlink(target, link);

        await expect(atomicWriteUserConfig(link, '{}\n')).rejects.toMatchObject({ code: 'IO' });

        expect((await stat(target)).isDirectory()).toBe(true);
        expect(await strayTemporaryFiles(directory)).toEqual([]);
    });
});
