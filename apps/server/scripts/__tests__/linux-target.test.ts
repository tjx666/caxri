import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import type { LinuxRuntimeSource } from '../linux-target';
import { extractLinuxNode, resolveHostNodeLicense } from '../linux-target';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function fixtureFile(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
}

async function runtimeTarball(root: string, hasLicense: boolean): Promise<LinuxRuntimeSource> {
    const prefix = 'node-v24.20.0-linux-x64';
    const staging = join(root, 'staging');
    await fixtureFile(join(staging, prefix, 'bin', 'node'), 'matching node runtime');
    if (hasLicense) await fixtureFile(join(staging, prefix, 'LICENSE'), 'matching node license');
    const tarballPath = join(root, 'node.tar.gz');
    await execFileAsync('tar', ['-czf', tarballPath, '-C', staging, prefix]);
    const sha256 = createHash('sha256')
        .update(await readFile(tarballPath))
        .digest('hex');
    return {
        member: `${prefix}/bin/node`,
        sha256,
        tarballPath,
        url: `https://nodejs.org/dist/v24.20.0/${prefix}.tar.gz`,
    };
}

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
});

describe('Linux Node runtime extraction', () => {
    it('extracts the runtime and LICENSE from the same verified tarball', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-linux-runtime-'));
        temporaryDirectories.push(root);
        const source = await runtimeTarball(root, true);
        const destination = join(root, 'output', 'node');

        const license = await extractLinuxNode(source, destination, join(root, 'cache'));

        expect(await readFile(destination, 'utf8')).toBe('matching node runtime');
        expect(await readFile(license, 'utf8')).toBe('matching node license');
    });

    it('fails when the verified runtime archive has no matching top-level LICENSE', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-linux-runtime-'));
        temporaryDirectories.push(root);
        const source = await runtimeTarball(root, false);

        await expect(
            extractLinuxNode(source, join(root, 'output', 'node'), join(root, 'cache')),
        ).rejects.toThrow();
    });
});

describe('host Node runtime license', () => {
    it('resolves the license beside the installation that owns a linked executable', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-host-runtime-'));
        temporaryDirectories.push(root);
        const executable = join(root, 'node-installation', 'bin', 'node');
        const license = join(root, 'node-installation', 'LICENSE');
        const linkedExecutable = join(root, 'shim', 'node');
        await Promise.all([
            fixtureFile(executable, 'host node runtime'),
            fixtureFile(license, 'host node license'),
            mkdir(dirname(linkedExecutable), { recursive: true }),
        ]);
        await symlink(executable, linkedExecutable);

        expect(await resolveHostNodeLicense(linkedExecutable)).toBe(await realpath(license));
    });
});
