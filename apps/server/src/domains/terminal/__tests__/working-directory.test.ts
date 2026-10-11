import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { resolveTerminalWorkingDirectory } from '../working-directory';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

it('uses the Workbench Root default while authorizing both Session roots', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-terminal-working-directory-'));
    temporaryDirectories.push(directory);
    const canonicalDirectory = await realpath(directory);
    const owner = join(canonicalDirectory, 'owner');
    const workbench = join(canonicalDirectory, 'workbench');
    const workbenchFolder = join(workbench, 'packages');
    const outside = join(canonicalDirectory, 'outside');
    await Promise.all([mkdir(owner), mkdir(workbenchFolder, { recursive: true }), mkdir(outside)]);

    await expect(
        resolveTerminalWorkingDirectory({
            authorizedRoots: [owner, workbench],
            defaultRoot: workbench,
        }),
    ).resolves.toBe(workbench);
    await expect(
        resolveTerminalWorkingDirectory({
            authorizedRoots: [owner, workbench],
            defaultRoot: workbench,
            requestedCwd: workbenchFolder,
        }),
    ).resolves.toBe(workbenchFolder);
    await expect(
        resolveTerminalWorkingDirectory({
            authorizedRoots: [owner, workbench],
            defaultRoot: workbench,
            requestedCwd: outside,
        }),
    ).rejects.toMatchObject({ code: 'PATH_DENIED' });
});

it('keeps the configured directory above the Workbench Root default', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-terminal-working-directory-setting-'));
    temporaryDirectories.push(directory);
    const canonicalDirectory = await realpath(directory);
    const workbench = join(canonicalDirectory, 'workbench');
    const configured = join(canonicalDirectory, 'configured');
    const file = join(canonicalDirectory, 'file');
    await Promise.all([mkdir(workbench), mkdir(configured), writeFile(file, 'fixture')]);

    await expect(
        resolveTerminalWorkingDirectory({
            authorizedRoots: [workbench],
            configured,
            defaultRoot: workbench,
        }),
    ).resolves.toBe(configured);
    await expect(
        resolveTerminalWorkingDirectory({
            authorizedRoots: [workbench],
            configured: file,
            defaultRoot: workbench,
        }),
    ).rejects.toMatchObject({ code: 'IO' });
});
