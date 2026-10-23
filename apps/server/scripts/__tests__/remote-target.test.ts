import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import type { NodeRuntimeSource } from '../remote-target';
import { assertMacosBaseline, extractNodeRuntime, resolveHostNodeLicense } from '../remote-target';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function fixtureFile(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
}

async function runtimeTarball(root: string, hasLicense: boolean): Promise<NodeRuntimeSource> {
    /**
     * Keeps extraction fixtures from becoming a second source for the repository toolchain version.
     */
    const fixtureVersion = '0.0.0-test';
    const prefix = `node-v${fixtureVersion}-linux-x64`;
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
        url: `https://nodejs.org/dist/v${fixtureVersion}/${prefix}.tar.gz`,
    };
}

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
});

describe('Node runtime extraction', () => {
    it('extracts the runtime and LICENSE from the same verified tarball', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-linux-runtime-'));
        temporaryDirectories.push(root);
        const source = await runtimeTarball(root, true);
        const destination = join(root, 'output', 'node');

        const license = await extractNodeRuntime(source, destination, join(root, 'cache'));

        expect(await readFile(destination, 'utf8')).toBe('matching node runtime');
        expect(await readFile(license, 'utf8')).toBe('matching node license');
    });

    it('fails when the verified runtime archive has no matching top-level LICENSE', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-linux-runtime-'));
        temporaryDirectories.push(root);
        const source = await runtimeTarball(root, false);

        await expect(
            extractNodeRuntime(source, join(root, 'output', 'node'), join(root, 'cache')),
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

describe.skipIf(process.platform !== 'darwin')('darwin-arm64 macOS baseline', () => {
    async function compile(output: string, minimum: string): Promise<void> {
        await mkdir(dirname(output), { recursive: true });
        const source = `${output}.c`;
        await writeFile(source, 'int main(void) { return 0; }\n');
        await execFileAsync('cc', [`-mmacosx-version-min=${minimum}`, '-o', output, source]);
        await rm(source);
    }

    it('accepts binaries at the baseline and ignores non-Mach-O files', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-macos-baseline-'));
        temporaryDirectories.push(root);
        await fixtureFile(join(root, 'bundles', 'server-core.js'), 'console.log(1);');
        await compile(join(root, 'runtime', 'bin', 'node'), '13.5');
        // System binaries also carry linker-tool `version` lines far above any macOS number.
        await copyFile('/bin/ls', join(root, 'runtime', 'bin', 'ls'));

        await expect(assertMacosBaseline(root)).resolves.toBeUndefined();
    });

    it('names a binary that needs a newer macOS', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-macos-baseline-'));
        temporaryDirectories.push(root);
        await compile(join(root, 'native', 'addon.node'), '15.0');

        await expect(assertMacosBaseline(root)).rejects.toThrow('native/addon.node (15.0)');
    });
});
