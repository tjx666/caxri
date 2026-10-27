import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveServerArtifact } from '../artifact';

const temporaryDirectories: string[] = [];

async function fixtureFile(path: string, contents = 'fixture'): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
}

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
});

describe('Server artifact discovery', () => {
    it('resolves only manifest-declared runtime and entrypoint paths', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-server-descriptor-'));
        temporaryDirectories.push(root);
        const executable = join(root, 'runtime', 'bin', 'node');
        const manifest = {
            architecture: process.arch,
            artifactKind: 'caxri-server',
            commit: '01234567',
            entrypoints: {
                extensionHost: 'bundles/extension-host.js',
                server: 'bundles/server-core.js',
                terminalHost: 'bundles/terminal-host.js',
            },
            extensions: [],
            integrity: { aggregateSha256: 'a'.repeat(64), algorithm: 'sha256', files: [] },
            nativeDependencies: [],
            platform: process.platform,
            protocolVersion: 2,
            runtime: { executable: 'runtime/bin/node', version: '24.0.0-fixture' },
            schemaVersion: 2,
            version: '0.0.18',
        };
        await Promise.all([
            fixtureFile(executable),
            fixtureFile(join(root, 'bundles', 'extension-host.js')),
            fixtureFile(join(root, 'bundles', 'server-core.js')),
            fixtureFile(join(root, 'bundles', 'terminal-host.js')),
            fixtureFile(join(root, 'metadata', 'manifest.json'), `${JSON.stringify(manifest)}\n`),
        ]);
        await chmod(executable, 0o755);
        const canonicalRoot = await realpath(root);

        await expect(resolveServerArtifact(root)).resolves.toMatchObject({
            bundleDirectory: join(canonicalRoot, 'bundles'),
            entryPath: join(canonicalRoot, 'bundles', 'server-core.js'),
            executablePath: join(canonicalRoot, 'runtime', 'bin', 'node'),
            rootPath: canonicalRoot,
        });
    });

    it('rejects a manifest path that escapes the artifact root', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-server-descriptor-'));
        temporaryDirectories.push(root);
        await fixtureFile(
            join(root, 'metadata', 'manifest.json'),
            JSON.stringify({
                architecture: process.arch,
                artifactKind: 'caxri-server',
                commit: '01234567',
                entrypoints: {
                    extensionHost: 'bundles/extension-host.js',
                    server: '../server-core.js',
                    terminalHost: 'bundles/terminal-host.js',
                },
                extensions: [],
                integrity: { aggregateSha256: 'a'.repeat(64), algorithm: 'sha256', files: [] },
                nativeDependencies: [],
                platform: process.platform,
                protocolVersion: 2,
                runtime: { executable: 'runtime/bin/node', version: '24.0.0-fixture' },
                schemaVersion: 2,
                version: '0.0.18',
            }),
        );

        await expect(resolveServerArtifact(root)).rejects.toThrow('Server artifact manifest');
    });

    it.skipIf(process.platform === 'win32')(
        'rejects a FIFO planted as the manifest instead of blocking on open',
        async () => {
            const root = await mkdtemp(join(tmpdir(), 'caxri-server-descriptor-fifo-'));
            temporaryDirectories.push(root);
            await mkdir(join(root, 'metadata'), { recursive: true });
            await promisify(execFile)('mkfifo', [join(root, 'metadata', 'manifest.json')]);

            let timer: NodeJS.Timeout | undefined;
            const timeout = new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('manifest read blocked')), 2_000);
            });
            try {
                await expect(Promise.race([resolveServerArtifact(root), timeout])).rejects.toThrow(
                    'Server artifact manifest is invalid',
                );
            } finally {
                clearTimeout(timer);
            }
        },
    );
});
