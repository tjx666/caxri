import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assembleServerArtifact, verifyServerArtifact } from '../artifact';

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

describe('standalone Server artifact', () => {
    it('assembles the complete layout and binds every runtime input to its manifest', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-server-artifact-'));
        temporaryDirectories.push(root);
        const sources = join(root, 'sources');
        const artifactRoot = join(root, 'output', 'server');
        const runtimeExecutable = join(sources, 'node');
        await Promise.all([
            fixtureFile(join(sources, 'bundles', 'host.js'), 'host'),
            fixtureFile(join(sources, 'bundles', 'extension-host.js'), 'extension-host'),
            fixtureFile(runtimeExecutable, '#!/bin/sh\nexit 0\n'),
            fixtureFile(join(sources, 'native', 'better-sqlite3', 'package.json'), '{}'),
            fixtureFile(join(sources, 'migrations', '0000.sql'), 'SELECT 1;'),
            fixtureFile(join(sources, 'migrations', 'meta', '_journal.json'), '{}'),
            fixtureFile(join(sources, 'extensions', 'git', 'package.json'), '{}'),
            fixtureFile(join(sources, 'extensions', 'git', 'dist', 'extension.js'), 'export {};'),
        ]);
        await chmod(runtimeExecutable, 0o755);

        const manifest = await assembleServerArtifact({
            architecture: 'arm64',
            artifactRoot,
            bundleSource: join(sources, 'bundles'),
            commit: '01234567',
            extensions: [{ id: 'caxri.git', source: join(sources, 'extensions', 'git') }],
            migrationsSource: join(sources, 'migrations'),
            nativePackages: [
                {
                    name: 'better-sqlite3',
                    source: join(sources, 'native', 'better-sqlite3'),
                    version: '13.0.2',
                },
            ],
            platform: 'darwin',
            protocolVersion: 2,
            runtime: { executable: runtimeExecutable, version: '24.0.0-fixture' },
            version: '0.0.18',
        });

        expect(manifest).toMatchObject({
            architecture: 'arm64',
            artifactKind: 'caxri-server',
            commit: '01234567',
            entrypoints: {
                extensionHost: 'bundles/extension-host.js',
                server: 'bundles/host.js',
            },
            platform: 'darwin',
            protocolVersion: 2,
            runtime: { executable: 'runtime/bin/node', version: '24.0.0-fixture' },
            schemaVersion: 1,
            version: '0.0.18',
        });
        expect(manifest.integrity.files.map(({ path }) => path)).toEqual(
            expect.arrayContaining([
                'bundles/host.js',
                'extensions/git/dist/extension.js',
                'migrations/0000.sql',
                'native/node_modules/better-sqlite3/package.json',
                'runtime/bin/node',
                'runtime/caxri-server',
            ]),
        );
        expect(await verifyServerArtifact(artifactRoot)).toEqual(manifest);
        expect(await readFile(join(artifactRoot, 'metadata', 'manifest.json'), 'utf8')).toContain(
            manifest.integrity.aggregateSha256,
        );
    });

    it('rejects a copied artifact after an input is changed', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-server-artifact-'));
        temporaryDirectories.push(root);
        const artifactRoot = join(root, 'server');
        const bundleSource = join(root, 'bundles');
        const runtimeExecutable = join(root, 'node');
        await Promise.all([
            fixtureFile(join(bundleSource, 'host.js'), 'host'),
            fixtureFile(join(bundleSource, 'extension-host.js'), 'extension-host'),
            fixtureFile(runtimeExecutable, 'runtime'),
            fixtureFile(join(root, 'migrations', '0000.sql'), 'SELECT 1;'),
        ]);
        await chmod(runtimeExecutable, 0o755);
        await assembleServerArtifact({
            architecture: 'arm64',
            artifactRoot,
            bundleSource,
            commit: '01234567',
            extensions: [],
            migrationsSource: join(root, 'migrations'),
            nativePackages: [],
            platform: 'darwin',
            protocolVersion: 2,
            runtime: { executable: runtimeExecutable, version: '24.0.0-fixture' },
            version: '0.0.18',
        });

        await writeFile(join(artifactRoot, 'bundles', 'host.js'), 'tampered');
        await expect(verifyServerArtifact(artifactRoot)).rejects.toThrow(
            'Server artifact integrity verification failed',
        );
    });
});
