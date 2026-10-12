import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import type { ServerArtifactFileReceipt, ServerArtifactManifest } from '@caxri/protocol';
import { serverArtifactManifestSchema } from '@caxri/protocol';

export interface ServerArtifactInput {
    architecture: string;
    artifactRoot: string;
    bundleSource: string;
    /**
     * The `caxri` CLI bundle, copied to `cli/caxri.cjs`. Only SSH Host targets ship it: on macOS the Desktop app bundle
     * already carries the CLI beside the Server.
     */
    cliBundle?: string;
    commit: string;
    extensions: Array<{ id: string; source: string }>;
    migrationsSource: string;
    nativePackages: Array<{ name: string; source: string; version: string }>;
    platform: string;
    protocolVersion: number;
    /**
     * Drops `*.map` files from the copied bundles. SSH Host targets set it because every byte is uploaded over SSH and
     * remote stack traces are not symbolicated; the bundles themselves stay byte-identical, so the build fingerprint is
     * unchanged.
     */
    omitSourceMaps?: boolean;
    ripgrep: { executable: string; ripgrepLicense: string; vscodeLicense: string };
    runtime: { executable: string; version: string };
    runtimeSource?: { member: string; sha256: string; url: string };
    version: string;
}

const manifestRelativePath = join('metadata', 'manifest.json');
const requiredBundleNames = [
    'agent-launcher.js',
    'extension-host.js',
    'project-search-worker.js',
    'server-core.js',
    'terminal-host.js',
] as const;

function compareCodeUnits(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

function assertSafeArtifactRoot(path: string): void {
    const normalized = resolve(path);
    if (basename(normalized) !== 'server' || dirname(normalized) === normalized) {
        throw new Error(`Server artifact root must end in an explicit server directory: ${path}`);
    }
}

function assertSafePackageName(name: string): void {
    if (!/^(?:@[a-z\d][a-z\d._-]*\/)?[a-z\d][a-z\d._-]*$/u.test(name)) {
        throw new Error(`Invalid native package name: ${name}`);
    }
}

async function sha256File(path: string): Promise<string> {
    const digest = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(path);
        stream.on('data', (chunk) => digest.update(chunk));
        stream.once('error', reject);
        stream.once('end', resolve);
    });
    return digest.digest('hex');
}

async function walkFiles(root: string, current = root): Promise<string[]> {
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
        throw new Error(`Server artifact cannot contain symbolic links: ${current}`);
    }
    if (metadata.isFile()) return [current];
    if (!metadata.isDirectory()) {
        throw new Error(`Server artifact contains an unsupported entry: ${current}`);
    }
    const entries = (await readdir(current)).toSorted(compareCodeUnits);
    return (
        await Promise.all(entries.map((entry) => walkFiles(root, join(current, entry))))
    ).flat();
}

async function hasPath(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
    }
}

async function copyMigrations(source: string, destination: string): Promise<void> {
    const entries = await readdir(source, { withFileTypes: true });
    await Promise.all(
        entries.flatMap((entry) => {
            if (entry.isFile() && entry.name.endsWith('.sql')) {
                return cp(join(source, entry.name), join(destination, entry.name));
            }
            if (entry.isDirectory() && entry.name === 'meta') {
                return cp(join(source, entry.name), join(destination, entry.name), {
                    recursive: true,
                });
            }
            return [];
        }),
    );
}

async function copyExtension(source: string, destination: string): Promise<void> {
    await mkdir(destination, { recursive: true });
    await cp(join(source, 'package.json'), join(destination, 'package.json'));
    await cp(join(source, 'dist'), join(destination, 'dist'), { recursive: true });
    const mediaSource = join(source, 'media');
    if (await hasPath(mediaSource)) {
        await cp(mediaSource, join(destination, 'media'), { recursive: true });
    }
}

async function artifactReceipts(root: string): Promise<ServerArtifactFileReceipt[]> {
    const files = await walkFiles(root);
    return Promise.all(
        files
            .filter((path) => relative(root, path) !== manifestRelativePath)
            .map(async (path) => {
                const metadata = await lstat(path);
                return {
                    mode: metadata.mode & 0o777,
                    path: relative(root, path).split(sep).join('/'),
                    sha256: await sha256File(path),
                    size: metadata.size,
                };
            }),
    );
}

function aggregateReceipts(files: ServerArtifactFileReceipt[]): string {
    return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

function launcherSource(): string {
    return `#!/bin/sh
set -eu
runtime_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$runtime_directory/bin/node" "$runtime_directory/../bundles/server-core.js" "$@"
`;
}

export async function assembleServerArtifact(
    input: ServerArtifactInput,
): Promise<ServerArtifactManifest> {
    assertSafeArtifactRoot(input.artifactRoot);
    await rm(input.artifactRoot, { force: true, recursive: true });
    await Promise.all([
        mkdir(join(input.artifactRoot, 'bundles'), { recursive: true }),
        mkdir(join(input.artifactRoot, 'extensions'), { recursive: true }),
        mkdir(join(input.artifactRoot, 'metadata'), { recursive: true }),
        mkdir(join(input.artifactRoot, 'migrations'), { recursive: true }),
        mkdir(join(input.artifactRoot, 'native', 'node_modules'), { recursive: true }),
        mkdir(join(input.artifactRoot, 'licenses'), { recursive: true }),
        mkdir(join(input.artifactRoot, 'runtime', 'bin'), { recursive: true }),
    ]);

    await cp(input.bundleSource, join(input.artifactRoot, 'bundles'), {
        filter: (source) => !input.omitSourceMaps || !source.endsWith('.map'),
        recursive: true,
    });
    if (input.cliBundle) {
        await mkdir(join(input.artifactRoot, 'cli'), { recursive: true });
        await cp(input.cliBundle, join(input.artifactRoot, 'cli', 'caxri.cjs'));
        await chmod(join(input.artifactRoot, 'cli', 'caxri.cjs'), 0o755);
    }
    await Promise.all(
        requiredBundleNames.map(async (bundleName) => {
            const metadata = await lstat(join(input.artifactRoot, 'bundles', bundleName));
            if (!metadata.isFile()) throw new Error(`Missing Server bundle: ${bundleName}`);
        }),
    );
    await copyMigrations(input.migrationsSource, join(input.artifactRoot, 'migrations'));

    const extensions: Array<{ id: string; path: string }> = await Promise.all(
        input.extensions.map(async (extension) => {
            const directoryName = basename(extension.source);
            await copyExtension(
                extension.source,
                join(input.artifactRoot, 'extensions', directoryName),
            );
            return { id: extension.id, path: `extensions/${directoryName}` };
        }),
    );

    await Promise.all(
        input.nativePackages.map(async (nativePackage) => {
            assertSafePackageName(nativePackage.name);
            await cp(
                nativePackage.source,
                join(
                    input.artifactRoot,
                    'native',
                    'node_modules',
                    ...nativePackage.name.split('/'),
                ),
                { recursive: true },
            );
        }),
    );

    const runtimeExecutable = join(input.artifactRoot, 'runtime', 'bin', 'node');
    await cp(input.runtime.executable, runtimeExecutable);
    await chmod(runtimeExecutable, 0o755);
    const ripgrepExecutable = join(input.artifactRoot, 'runtime', 'bin', 'rg');
    const ripgrepMetadata = await lstat(input.ripgrep.executable);
    if (!ripgrepMetadata.isFile() || ripgrepMetadata.isSymbolicLink())
        throw new Error('ripgrep executable must be a regular file');
    await cp(input.ripgrep.executable, ripgrepExecutable);
    await chmod(ripgrepExecutable, 0o755);
    await Promise.all(
        [
            ['RIPGREP_LICENSE.txt', input.ripgrep.ripgrepLicense],
            ['VSCODE_RIPGREP_LICENSE.txt', input.ripgrep.vscodeLicense],
        ].map(async ([name, source]) => {
            const metadata = await lstat(source);
            if (!metadata.isFile() || metadata.isSymbolicLink())
                throw new Error(`${name} must be a regular file`);
            await cp(source, join(input.artifactRoot, 'licenses', name));
        }),
    );
    const launcher = join(input.artifactRoot, 'runtime', 'caxri-server');
    await writeFile(launcher, launcherSource(), { mode: 0o755 });

    const files = await artifactReceipts(input.artifactRoot);
    const manifest = serverArtifactManifestSchema.parse({
        architecture: input.architecture,
        artifactKind: 'caxri-server',
        commit: input.commit,
        entrypoints: {
            extensionHost: 'bundles/extension-host.js',
            server: 'bundles/server-core.js',
            terminalHost: 'bundles/terminal-host.js',
        },
        extensions: extensions.toSorted((left, right) => compareCodeUnits(left.id, right.id)),
        integrity: {
            aggregateSha256: aggregateReceipts(files),
            algorithm: 'sha256',
            files,
        },
        nativeDependencies: input.nativePackages
            .map(({ name, version }) => ({ name, version }))
            .toSorted((left, right) => compareCodeUnits(left.name, right.name)),
        platform: input.platform,
        protocolVersion: input.protocolVersion,
        runtime: {
            executable: 'runtime/bin/node',
            ...(input.runtimeSource && { source: input.runtimeSource }),
            version: input.runtime.version,
        },
        schemaVersion: 2,
        version: input.version,
    });
    await writeFile(
        join(input.artifactRoot, manifestRelativePath),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o644 },
    );
    return manifest;
}

export async function verifyServerArtifact(root: string): Promise<ServerArtifactManifest> {
    const manifestPath = join(root, manifestRelativePath);
    const manifestSource = await readFile(manifestPath, 'utf8');
    const manifest = serverArtifactManifestSchema.parse(JSON.parse(manifestSource) as unknown);
    const files = await artifactReceipts(root);
    if (
        JSON.stringify(manifest.integrity.files) !== JSON.stringify(files) ||
        manifest.integrity.aggregateSha256 !== aggregateReceipts(files)
    ) {
        throw new Error('Server artifact integrity verification failed');
    }
    return manifest;
}
