#!/usr/bin/env bun

import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';

import { selectNodePtyNativeDirectory } from '../../../scripts/node-pty-layout';
import { assembleServerArtifact, verifyServerArtifact } from './artifact';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../../..');
const serverRoot = resolve(import.meta.dirname, '..');
const nativeStageRoot = resolve(root, '.cache/server-artifact-native');
const directNativePackageNames = ['@parcel/watcher', 'better-sqlite3', 'node-pty'] as const;

interface PackageManifest {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    version: string;
}

async function packageManifest(path: string): Promise<PackageManifest> {
    return JSON.parse(await readFile(path, 'utf8')) as PackageManifest;
}

function betterSqlitePrebuildName(): string {
    const report = process.report.getReport() as {
        header?: { glibcVersionRuntime?: string };
    };
    const linuxPrefix =
        process.platform === 'linux' && !report.header?.glibcVersionRuntime
            ? 'linuxmusl'
            : process.platform;
    return `${linuxPrefix}-${process.arch}.node`;
}

async function copyRuntimePackage(
    name: string,
    source: string,
    destination: string,
): Promise<void> {
    const nodePtyNativeDirectory =
        name === 'node-pty'
            ? selectNodePtyNativeDirectory(
                  { arch: process.arch, packageRoot: source, platform: process.platform },
                  (path) => {
                      try {
                          require(path);
                          return true;
                      } catch {
                          return false;
                      }
                  },
              )
            : undefined;
    if (name === 'node-pty' && !nodePtyNativeDirectory) {
        throw new Error('No loadable node-pty native layout is available for Server staging');
    }
    const nodePtyNativeEntry = nodePtyNativeDirectory
        ? relative(source, nodePtyNativeDirectory)
        : '';
    const selectedEntries = new Map<string, readonly string[]>([
        ['@parcel/watcher', ['LICENSE', 'index.js', 'package.json', 'wrapper.js']],
        [
            'better-sqlite3',
            ['LICENSE', 'lib', 'package.json', `prebuilds/${betterSqlitePrebuildName()}`],
        ],
        ['node-pty', ['LICENSE', 'lib', 'package.json', nodePtyNativeEntry]],
    ]);
    const entries = selectedEntries.get(name);
    if (!entries) {
        await cp(source, destination, { recursive: true });
        return;
    }
    await mkdir(destination, { recursive: true });
    await Promise.all(
        entries.map(async (entry) => {
            await mkdir(dirname(join(destination, entry)), { recursive: true });
            await cp(join(source, entry), join(destination, entry), { recursive: true });
        }),
    );
    if (name === 'node-pty' && process.platform !== 'win32') {
        await chmod(join(destination, nodePtyNativeEntry, 'spawn-helper'), 0o755);
    }
}

function packageManifestPath(name: string, searchPath: string): string {
    return require.resolve(`${name}/package.json`, { paths: [searchPath] });
}

async function stageDependency(
    dependency: string,
    isOptional: boolean,
    source: string,
    destination: string,
    ancestors: Set<string>,
): Promise<void> {
    try {
        await stagePackageTree(
            dependency,
            source,
            join(destination, 'node_modules', ...dependency.split('/')),
            ancestors,
        );
    } catch (error) {
        if (
            isOptional &&
            error instanceof Error &&
            'code' in error &&
            error.code === 'MODULE_NOT_FOUND'
        ) {
            return;
        }
        throw error;
    }
}

async function stagePackageTree(
    name: string,
    searchPath: string,
    destination: string,
    ancestors = new Set<string>(),
): Promise<{ source: string; version: string }> {
    const manifestPath = packageManifestPath(name, searchPath);
    const source = dirname(manifestPath);
    const manifest = await packageManifest(manifestPath);
    const identity = `${name}@${manifest.version}`;
    if (ancestors.has(identity)) throw new Error(`Native dependency cycle: ${identity}`);
    await copyRuntimePackage(name, source, destination);
    const nextAncestors = new Set(ancestors).add(identity);
    const dependencies = [
        ...Object.keys(manifest.dependencies ?? {}).map((value) => [value, false] as const),
        ...Object.keys(manifest.optionalDependencies ?? {}).map((value) => [value, true] as const),
    ];
    await Promise.all(
        dependencies.map(([dependency, isOptional]) =>
            stageDependency(dependency, isOptional, source, destination, nextAncestors),
        ),
    );
    return { source: destination, version: manifest.version };
}

async function commandOutput(command: string, arguments_: string[]): Promise<string> {
    const { stdout } = await execFileAsync(command, arguments_, { cwd: root, encoding: 'utf8' });
    return stdout.trim();
}

async function commandOutputOrEmpty(command: string, arguments_: string[]): Promise<string> {
    try {
        return await commandOutput(command, arguments_);
    } catch {
        return '';
    }
}

async function runtimeExecutable(version: string): Promise<string> {
    const explicit = process.env.CAXRI_SERVER_RUNTIME_EXECUTABLE;
    const candidates = explicit
        ? [explicit]
        : [
              await commandOutput('node', ['-p', 'process.execPath']),
              await commandOutputOrEmpty('mise', ['which', 'node']),
          ];
    const inspectedCandidates = await Promise.all(
        candidates.map(async (candidate) => ({
            candidate,
            version: candidate ? await commandOutputOrEmpty(candidate, ['--version']) : '',
        })),
    );
    const matched = inspectedCandidates.find(
        ({ version: actualVersion }) => actualVersion === `v${version}`,
    );
    if (matched) return matched.candidate;
    throw new Error(
        `Pinned Server runtime ${version} is unavailable; install the mise toolchain or set CAXRI_SERVER_RUNTIME_EXECUTABLE`,
    );
}

const workspaceManifest = await packageManifest(resolve(root, 'package.json'));
const miseSource = await readFile(resolve(root, 'mise.toml'), 'utf8');
const runtimeVersion = /^node\s*=\s*"([^"]+)"$/mu.exec(miseSource)?.[1];
if (!runtimeVersion) throw new Error('mise.toml must pin the Server runtime version');
const executable = await runtimeExecutable(runtimeVersion);
const commit = (await commandOutputOrEmpty('git', ['rev-parse', '--short=8', 'HEAD'])) || 'unknown';

await rm(nativeStageRoot, { force: true, recursive: true });
await mkdir(nativeStageRoot, { recursive: true });
const nativePackages: Array<{ name: string; source: string; version: string }> = await Promise.all(
    directNativePackageNames.map(async (name) => {
        const destination = join(nativeStageRoot, ...name.split('/'));
        return {
            name,
            ...(await stagePackageTree(name, serverRoot, destination)),
        };
    }),
);

const artifactRoot = resolve(serverRoot, 'dist/server');
const extensions = [
    { id: 'caxri.git', source: resolve(root, 'extensions/git') },
    { id: 'caxri.project-status', source: resolve(root, 'extensions/status') },
];
if (process.env.CAXRI_SERVER_INCLUDE_TEST_EXTENSION === '1') {
    extensions.push({ id: 'caxri.fixture', source: resolve(root, 'extensions/fixture') });
}
const manifest = await assembleServerArtifact({
    architecture: process.arch,
    artifactRoot,
    bundleSource: resolve(serverRoot, 'dist/bundles'),
    commit,
    extensions,
    migrationsSource: resolve(serverRoot, 'src/domains/db/migrations'),
    nativePackages,
    platform: process.platform,
    protocolVersion: CAXRI_PROTOCOL_VERSION,
    runtime: { executable, version: runtimeVersion },
    version: workspaceManifest.version,
});
await verifyServerArtifact(artifactRoot);
await rm(nativeStageRoot, { force: true, recursive: true });
process.stdout.write(
    `Built standalone Server artifact ${manifest.integrity.aggregateSha256} (${manifest.integrity.files.length} files)\n`,
);
