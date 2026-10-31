import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
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
        const runtimeLicense = join(sources, 'NODE_LICENSE');
        const ripgrepExecutable = join(sources, 'rg');
        const licensesDirectory = join(sources, 'licenses');
        const ripgrepLicense = join(licensesDirectory, 'RIPGREP_LICENSE.txt');
        const vscodeRipgrepLicense = join(licensesDirectory, 'VSCODE_RIPGREP_LICENSE.txt');
        const projectLicense = join(sources, 'LICENSE');
        const thirdPartyNotices = join(sources, 'THIRD_PARTY_NOTICES.md');
        await Promise.all([
            fixtureFile(join(sources, 'bundles', 'server-core.js'), 'server-core'),
            fixtureFile(join(sources, 'bundles', 'agent-launcher.js'), 'agent-launcher'),
            fixtureFile(join(sources, 'bundles', 'extension-host.js'), 'extension-host'),
            fixtureFile(join(sources, 'bundles', 'project-search-worker.js'), 'search-worker'),
            fixtureFile(join(sources, 'bundles', 'terminal-host.js'), 'terminal-host'),
            fixtureFile(runtimeExecutable, '#!/bin/sh\nexit 0\n'),
            fixtureFile(runtimeLicense, 'node runtime license'),
            fixtureFile(ripgrepExecutable, '#!/bin/sh\nexit 0\n'),
            fixtureFile(ripgrepLicense, 'ripgrep license'),
            fixtureFile(vscodeRipgrepLicense, 'vscode ripgrep license'),
            fixtureFile(join(licensesDirectory, 'ANOTHER_LICENSE.txt'), 'another license'),
            fixtureFile(projectLicense, 'project license'),
            fixtureFile(thirdPartyNotices, 'third-party notices'),
            ...[
                'package.json',
                'LICENSE.md',
                'README.md',
                'lib/database.js',
                'lib/database.js.map',
                'lib/database.test.js',
                'lib/index.d.ts',
            ].map((name) => fixtureFile(join(sources, 'native', 'better-sqlite3', name), '{}')),
            fixtureFile(join(sources, 'extensions', 'git', 'package.json'), '{}'),
            fixtureFile(join(sources, 'extensions', 'git', 'dist', 'extension.js'), 'export {};'),
            fixtureFile(join(sources, 'extensions', 'git', 'package.nls.json'), '{}'),
            fixtureFile(join(sources, 'extensions', 'git', 'package.nls.zh-cn.json'), '{}'),
            fixtureFile(join(sources, 'extensions', 'git', 'l10n', 'bundle.l10n.zh-cn.json'), '{}'),
        ]);
        await Promise.all([chmod(runtimeExecutable, 0o755), chmod(ripgrepExecutable, 0o755)]);

        const manifest = await assembleServerArtifact({
            architecture: 'arm64',
            artifactRoot,
            bundleSource: join(sources, 'bundles'),
            commit: '01234567',
            extensions: [{ id: 'caxri.git', source: join(sources, 'extensions', 'git') }],
            nativePackages: [
                {
                    name: 'better-sqlite3',
                    source: join(sources, 'native', 'better-sqlite3'),
                    version: '13.0.2',
                },
            ],
            platform: 'darwin',
            protocolVersion: 2,
            repositoryNotices: {
                licensesDirectory,
                projectLicense,
                thirdPartyNotices,
            },
            ripgrep: { executable: ripgrepExecutable },
            runtime: {
                executable: runtimeExecutable,
                license: runtimeLicense,
                version: '24.0.0-fixture',
            },
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
                'extensions/git/package.nls.json',
                'extensions/git/package.nls.zh-cn.json',
                'extensions/git/l10n/bundle.l10n.zh-cn.json',
                'native/node_modules/better-sqlite3/package.json',
                'LICENSE',
                'THIRD_PARTY_NOTICES.md',
                'licenses/ANOTHER_LICENSE.txt',
                'licenses/NODE_RUNTIME_LICENSE.txt',
                'licenses/RIPGREP_LICENSE.txt',
                'licenses/VSCODE_RIPGREP_LICENSE.txt',
                'runtime/bin/node',
                'runtime/bin/rg',
                'runtime/caxri-server',
            ]),
        );
        expect(
            new Set(
                manifest.integrity.files
                    .map(({ path }) => path)
                    .filter((path) => path.startsWith('native/node_modules/better-sqlite3/')),
            ),
        ).toEqual(
            new Set([
                'native/node_modules/better-sqlite3/LICENSE.md',
                'native/node_modules/better-sqlite3/lib/database.js',
                'native/node_modules/better-sqlite3/package.json',
            ]),
        );
        expect(
            manifest.integrity.files.find(({ path }) => path === 'runtime/bin/rg'),
        ).toMatchObject({ mode: 0o755 });
        expect(await readFile(join(artifactRoot, 'runtime', 'caxri-server'), 'utf8')).toContain(
            'exec "$runtime_directory/bin/node" --max-semi-space-size=8 "$runtime_directory/../bundles/server-core.js" "$@"',
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
        const runtimeLicense = join(root, 'NODE_LICENSE');
        const ripgrepExecutable = join(root, 'rg');
        const licensesDirectory = join(root, 'licenses');
        const ripgrepLicense = join(licensesDirectory, 'RIPGREP_LICENSE.txt');
        const vscodeRipgrepLicense = join(licensesDirectory, 'VSCODE_RIPGREP_LICENSE.txt');
        const projectLicense = join(root, 'LICENSE');
        const thirdPartyNotices = join(root, 'THIRD_PARTY_NOTICES.md');
        await Promise.all([
            fixtureFile(join(bundleSource, 'server-core.js'), 'server-core'),
            fixtureFile(join(bundleSource, 'agent-launcher.js'), 'agent-launcher'),
            fixtureFile(join(bundleSource, 'extension-host.js'), 'extension-host'),
            fixtureFile(join(bundleSource, 'project-search-worker.js'), 'search-worker'),
            fixtureFile(join(bundleSource, 'terminal-host.js'), 'terminal-host'),
            fixtureFile(runtimeExecutable, 'runtime'),
            fixtureFile(runtimeLicense, 'node runtime license'),
            fixtureFile(ripgrepExecutable, 'ripgrep'),
            fixtureFile(ripgrepLicense, 'ripgrep license'),
            fixtureFile(vscodeRipgrepLicense, 'vscode ripgrep license'),
            fixtureFile(projectLicense, 'project license'),
            fixtureFile(thirdPartyNotices, 'third-party notices'),
        ]);
        await Promise.all([chmod(runtimeExecutable, 0o755), chmod(ripgrepExecutable, 0o755)]);
        await assembleServerArtifact({
            architecture: 'arm64',
            artifactRoot,
            bundleSource,
            commit: '01234567',
            extensions: [],
            nativePackages: [],
            platform: 'darwin',
            protocolVersion: 2,
            repositoryNotices: {
                licensesDirectory,
                projectLicense,
                thirdPartyNotices,
            },
            ripgrep: { executable: ripgrepExecutable },
            runtime: {
                executable: runtimeExecutable,
                license: runtimeLicense,
                version: '24.0.0-fixture',
            },
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
        const runtimeLicense = join(root, 'NODE_LICENSE');
        const ripgrepExecutable = join(root, 'rg');
        const cliBundle = join(root, 'caxri.cjs');
        const licensesDirectory = join(root, 'licenses');
        const projectLicense = join(root, 'LICENSE');
        const thirdPartyNotices = join(root, 'THIRD_PARTY_NOTICES.md');
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
            fixtureFile(runtimeLicense, 'node runtime license'),
            fixtureFile(ripgrepExecutable, 'ripgrep'),
            fixtureFile(join(licensesDirectory, 'RIPGREP_LICENSE.txt'), 'ripgrep license'),
            fixtureFile(
                join(licensesDirectory, 'VSCODE_RIPGREP_LICENSE.txt'),
                'vscode ripgrep license',
            ),
            fixtureFile(projectLicense, 'project license'),
            fixtureFile(thirdPartyNotices, 'third-party notices'),
            fixtureFile(cliBundle, 'cli'),
        ]);
        const input = {
            architecture: 'x64',
            bundleSource,
            commit: '01234567',
            extensions: [],
            nativePackages: [],
            platform: 'linux',
            protocolVersion: 2,
            repositoryNotices: {
                licensesDirectory,
                projectLicense,
                thirdPartyNotices,
            },
            ripgrep: { executable: ripgrepExecutable },
            runtime: {
                executable: runtimeExecutable,
                license: runtimeLicense,
                version: '24.0.0-fixture',
            },
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

    it('fails closed when a repository license is linked or the matching runtime license is missing', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-server-artifact-'));
        temporaryDirectories.push(root);
        const bundleSource = join(root, 'bundles');
        const licensesDirectory = join(root, 'licenses');
        const runtimeLicense = join(root, 'NODE_LICENSE');
        await Promise.all([
            ...[
                'server-core.js',
                'agent-launcher.js',
                'extension-host.js',
                'project-search-worker.js',
                'terminal-host.js',
            ].map((name) => fixtureFile(join(bundleSource, name), name)),
            fixtureFile(join(root, 'node'), 'runtime'),
            fixtureFile(runtimeLicense, 'node runtime license'),
            fixtureFile(join(root, 'rg'), 'ripgrep'),
            fixtureFile(join(root, 'LICENSE'), 'project license'),
            fixtureFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'third-party notices'),
            fixtureFile(join(licensesDirectory, 'LICENSE.txt'), 'repository license'),
        ]);
        await symlink('LICENSE.txt', join(licensesDirectory, 'LINKED_LICENSE.txt'));
        const input = {
            architecture: 'arm64',
            artifactRoot: join(root, 'output', 'server'),
            bundleSource,
            commit: '01234567',
            extensions: [],
            nativePackages: [],
            platform: 'darwin',
            protocolVersion: 2,
            repositoryNotices: {
                licensesDirectory,
                projectLicense: join(root, 'LICENSE'),
                thirdPartyNotices: join(root, 'THIRD_PARTY_NOTICES.md'),
            },
            ripgrep: { executable: join(root, 'rg') },
            runtime: {
                executable: join(root, 'node'),
                license: runtimeLicense,
                version: '24.0.0-fixture',
            },
            version: '0.0.18',
        };

        await expect(assembleServerArtifact(input)).rejects.toThrow(
            'Repository license LINKED_LICENSE.txt must be a regular file',
        );
        await unlink(join(licensesDirectory, 'LINKED_LICENSE.txt'));
        const reservedLicense = join(licensesDirectory, 'node_runtime_license.txt');
        await fixtureFile(reservedLicense, 'conflicting license');
        await expect(assembleServerArtifact(input)).rejects.toThrow(
            'Repository licenses must not override NODE_RUNTIME_LICENSE.txt',
        );
        await Promise.all([unlink(reservedLicense), unlink(runtimeLicense)]);
        await expect(assembleServerArtifact(input)).rejects.toThrow(
            'Node runtime license is missing',
        );
    });
});
