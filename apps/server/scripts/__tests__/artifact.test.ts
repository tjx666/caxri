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
        const ripgrepExecutable = join(sources, 'rg');
        const ripgrepLicense = join(sources, 'RIPGREP_LICENSE.txt');
        const vscodeRipgrepLicense = join(sources, 'VSCODE_RIPGREP_LICENSE.txt');
        await Promise.all([
            fixtureFile(join(sources, 'bundles', 'server-core.js'), 'server-core'),
            fixtureFile(join(sources, 'bundles', 'agent-launcher.js'), 'agent-launcher'),
            fixtureFile(join(sources, 'bundles', 'extension-host.js'), 'extension-host'),
            fixtureFile(join(sources, 'bundles', 'project-search-worker.js'), 'search-worker'),
            fixtureFile(join(sources, 'bundles', 'terminal-host.js'), 'terminal-host'),
            fixtureFile(runtimeExecutable, '#!/bin/sh\nexit 0\n'),
            fixtureFile(ripgrepExecutable, '#!/bin/sh\nexit 0\n'),
            fixtureFile(ripgrepLicense, 'ripgrep license'),
            fixtureFile(vscodeRipgrepLicense, 'vscode ripgrep license'),
            fixtureFile(join(sources, 'native', 'better-sqlite3', 'package.json'), '{}'),
            fixtureFile(join(sources, 'migrations', '0000.sql'), 'SELECT 1;'),
            fixtureFile(join(sources, 'migrations', 'meta', '_journal.json'), '{}'),
            fixtureFile(join(sources, 'extensions', 'git', 'package.json'), '{}'),
            fixtureFile(join(sources, 'extensions', 'git', 'dist', 'extension.js'), 'export {};'),
        ]);
        await Promise.all([chmod(runtimeExecutable, 0o755), chmod(ripgrepExecutable, 0o755)]);

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
            ripgrep: {
                executable: ripgrepExecutable,
                ripgrepLicense,
                vscodeLicense: vscodeRipgrepLicense,
            },
            runtime: { executable: runtimeExecutable, version: '24.0.0-fixture' },
            version: '0.0.18',
        });

        expect(manifest).toMatchObject({
            architecture: 'arm64',
            artifactKind: 'caxri-server',
            commit: '01234567',
            entrypoints: {
                extensionHost: 'bundles/extension-host.js',
                server: 'bundles/server-core.js',
                terminalHost: 'bundles/terminal-host.js',
            },
            platform: 'darwin',
            protocolVersion: 2,
            runtime: { executable: 'runtime/bin/node', version: '24.0.0-fixture' },
            schemaVersion: 2,
            version: '0.0.18',
        });
        expect(manifest.integrity.files.map(({ path }) => path)).toEqual(
            expect.arrayContaining([
                'bundles/server-core.js',
                'bundles/agent-launcher.js',
                'bundles/project-search-worker.js',
                'bundles/terminal-host.js',
                'extensions/git/dist/extension.js',
                'migrations/0000.sql',
                'native/node_modules/better-sqlite3/package.json',
                'licenses/RIPGREP_LICENSE.txt',
                'licenses/VSCODE_RIPGREP_LICENSE.txt',
                'runtime/bin/node',
                'runtime/bin/rg',
                'runtime/caxri-server',
            ]),
        );
        expect(
            manifest.integrity.files.find(({ path }) => path === 'runtime/bin/rg'),
        ).toMatchObject({ mode: 0o755 });
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
        const ripgrepExecutable = join(root, 'rg');
        const ripgrepLicense = join(root, 'RIPGREP_LICENSE.txt');
        const vscodeRipgrepLicense = join(root, 'VSCODE_RIPGREP_LICENSE.txt');
        await Promise.all([
            fixtureFile(join(bundleSource, 'server-core.js'), 'server-core'),
            fixtureFile(join(bundleSource, 'agent-launcher.js'), 'agent-launcher'),
            fixtureFile(join(bundleSource, 'extension-host.js'), 'extension-host'),
            fixtureFile(join(bundleSource, 'project-search-worker.js'), 'search-worker'),
            fixtureFile(join(bundleSource, 'terminal-host.js'), 'terminal-host'),
            fixtureFile(runtimeExecutable, 'runtime'),
            fixtureFile(ripgrepExecutable, 'ripgrep'),
            fixtureFile(ripgrepLicense, 'ripgrep license'),
            fixtureFile(vscodeRipgrepLicense, 'vscode ripgrep license'),
            fixtureFile(join(root, 'migrations', '0000.sql'), 'SELECT 1;'),
        ]);
        await Promise.all([chmod(runtimeExecutable, 0o755), chmod(ripgrepExecutable, 0o755)]);
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
            ripgrep: {
                executable: ripgrepExecutable,
                ripgrepLicense,
                vscodeLicense: vscodeRipgrepLicense,
            },
            runtime: { executable: runtimeExecutable, version: '24.0.0-fixture' },
            version: '0.0.18',
        });

        await writeFile(join(artifactRoot, 'bundles', 'server-core.js'), 'tampered');
        await expect(verifyServerArtifact(artifactRoot)).rejects.toThrow(
            'Server artifact integrity verification failed',
        );
    });

    it('drops source maps and adds the CLI only for SSH Host targets', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-server-artifact-'));
        temporaryDirectories.push(root);
        const bundleSource = join(root, 'bundles');
        const runtimeExecutable = join(root, 'node');
        const ripgrepExecutable = join(root, 'rg');
        const cliBundle = join(root, 'caxri.cjs');
        await Promise.all([
            ...[
                'server-core.js',
                'agent-launcher.js',
                'extension-host.js',
                'project-search-worker.js',
                'terminal-host.js',
            ].flatMap((name) => [
                fixtureFile(join(bundleSource, name), name),
                fixtureFile(join(bundleSource, `${name}.map`), '{}'),
            ]),
            fixtureFile(runtimeExecutable, 'runtime'),
            fixtureFile(ripgrepExecutable, 'ripgrep'),
            fixtureFile(join(root, 'RIPGREP_LICENSE.txt'), 'ripgrep license'),
            fixtureFile(join(root, 'VSCODE_RIPGREP_LICENSE.txt'), 'vscode ripgrep license'),
            fixtureFile(join(root, 'migrations', '0000.sql'), 'SELECT 1;'),
            fixtureFile(cliBundle, 'cli'),
        ]);
        const input = {
            architecture: 'x64',
            bundleSource,
            commit: '01234567',
            extensions: [],
            migrationsSource: join(root, 'migrations'),
            nativePackages: [],
            platform: 'linux',
            protocolVersion: 2,
            ripgrep: {
                executable: ripgrepExecutable,
                ripgrepLicense: join(root, 'RIPGREP_LICENSE.txt'),
                vscodeLicense: join(root, 'VSCODE_RIPGREP_LICENSE.txt'),
            },
            runtime: { executable: runtimeExecutable, version: '24.0.0-fixture' },
            runtimeSource: {
                member: 'node-v24.0.0-linux-x64/bin/node',
                sha256: 'a'.repeat(64),
                url: 'https://nodejs.org/dist/v24.0.0/node-v24.0.0-linux-x64.tar.gz',
            },
            version: '0.0.18',
        };

        const local = await assembleServerArtifact({
            ...input,
            artifactRoot: join(root, 'local', 'server'),
        });
        const remote = await assembleServerArtifact({
            ...input,
            artifactRoot: join(root, 'remote', 'server'),
            cliBundle,
            omitSourceMaps: true,
        });

        const localPaths = local.integrity.files.map(({ path }) => path);
        const remotePaths = remote.integrity.files.map(({ path }) => path);
        expect(localPaths).toContain('bundles/server-core.js.map');
        expect(localPaths).not.toContain('cli/caxri.cjs');
        expect(remotePaths.filter((path) => path.endsWith('.map'))).toEqual([]);
        expect(remote.integrity.files.find(({ path }) => path === 'cli/caxri.cjs')).toMatchObject({
            mode: 0o755,
        });
        const bundles = (files: typeof local.integrity.files) =>
            files.filter(({ path }) => path.startsWith('bundles/') && path.endsWith('.js'));
        expect(bundles(remote.integrity.files)).toEqual(bundles(local.integrity.files));
        expect(remote.runtime.source?.url).toMatch(/\.tar\.gz$/u);
    });
});
