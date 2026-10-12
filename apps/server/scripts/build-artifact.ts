#!/usr/bin/env bun

import { execFile } from 'node:child_process';
import { access, chmod, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { binPathFor } from '@vscode/ripgrep-universal';

import { selectNodePtyNativeDirectory } from '../../../scripts/node-pty-layout';
import { assembleServerArtifact, verifyServerArtifact } from './artifact';
import type { LinuxNatives } from './linux-target';
import {
    ensureLinuxNatives,
    ensureLinuxRuntime,
    extractLinuxNode,
    parseLinuxTargets,
    pinnedRuntimeVersion,
} from './linux-target';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '../../..');
const serverRoot = resolve(import.meta.dirname, '..');
const nativeStageRootBase = resolve(root, '.cache/server-artifact-native');
const directNativePackageNames = ['@parcel/watcher', 'better-sqlite3', 'node-pty'] as const;
/**
 * Header-only packages that native addons need at compile time and never load at runtime.
 */
const buildOnlyDependencies = new Set(['node-addon-api']);

/**
 * The machine the artifact targets. The default is the build host; `--target linux-<arch>` cross-assembles the Server
 * an SSH Host runs, with natives built in a manylinux container (`linux-target.ts`).
 */
interface StagingTarget {
    arch: string;
    linuxNatives?: LinuxNatives;
    platform: NodeJS.Platform;
}

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

/**
 * Stages a native package for a cross-assembled Linux target: the platform-neutral JavaScript from the host install
 * plus the addon built in the manylinux container, placed where each package's own loader looks first.
 */
async function copyLinuxRuntimePackage(
    name: string,
    source: string,
    destination: string,
    target: StagingTarget & { linuxNatives: LinuxNatives },
): Promise<void> {
    const entries =
        name === '@parcel/watcher'
            ? ['LICENSE', 'index.js', 'package.json', 'wrapper.js']
            : ['LICENSE', 'lib', 'package.json'];
    await mkdir(destination, { recursive: true });
    await Promise.all(
        entries.map((entry) =>
            cp(join(source, entry), join(destination, entry), { recursive: true }),
        ),
    );
    switch (name) {
        case 'node-pty': {
            await mkdir(join(destination, 'build', 'Release'), { recursive: true });
            await cp(
                target.linuxNatives.nodePty,
                join(destination, 'build', 'Release', 'pty.node'),
            );
            break;
        }
        case 'better-sqlite3': {
            await mkdir(join(destination, 'prebuilds'), { recursive: true });
            await cp(
                target.linuxNatives.betterSqlite,
                join(destination, 'prebuilds', `linux-${target.arch}.node`),
            );
            break;
        }
        case '@parcel/watcher': {
            await cp(
                target.linuxNatives.watcherPackage,
                join(destination, 'node_modules', '@parcel', `watcher-linux-${target.arch}-glibc`),
                { recursive: true },
            );
            break;
        }
    }
}

async function copyRuntimePackage(
    name: string,
    source: string,
    destination: string,
    target: StagingTarget,
): Promise<void> {
    if (target.linuxNatives && directNativePackageNames.includes(name as never)) {
        await copyLinuxRuntimePackage(name, source, destination, {
            ...target,
            linuxNatives: target.linuxNatives,
        });
        return;
    }
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
    // node-pty 1.1.0 builds `spawn-helper` only on macOS; Linux forks directly.
    if (name === 'node-pty' && process.platform === 'darwin') {
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
    target: StagingTarget,
): Promise<void> {
    if (buildOnlyDependencies.has(dependency)) return;
    // Platform addon packages are resolved for the host; a cross-assembled target injects its own.
    if (isOptional && target.linuxNatives && dependency.startsWith('@parcel/watcher-')) return;
    try {
        await stagePackageTree(
            dependency,
            source,
            join(destination, 'node_modules', ...dependency.split('/')),
            target,
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
    target: StagingTarget,
    ancestors = new Set<string>(),
): Promise<{ source: string; version: string }> {
    const manifestPath = packageManifestPath(name, searchPath);
    const source = dirname(manifestPath);
    const manifest = await packageManifest(manifestPath);
    const identity = `${name}@${manifest.version}`;
    if (ancestors.has(identity)) throw new Error(`Native dependency cycle: ${identity}`);
    await copyRuntimePackage(name, source, destination, target);
    const nextAncestors = new Set(ancestors).add(identity);
    const dependencies = [
        ...Object.keys(manifest.dependencies ?? {}).map((value) => [value, false] as const),
        ...Object.keys(manifest.optionalDependencies ?? {}).map((value) => [value, true] as const),
    ];
    await Promise.all(
        dependencies.map(([dependency, isOptional]) =>
            stageDependency(dependency, isOptional, source, destination, nextAncestors, target),
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
const runtimeVersion = await pinnedRuntimeVersion();
const targetArguments = process.argv.slice(2);
const linuxTarget = targetArguments.includes('--target')
    ? parseLinuxTargets(targetArguments)[0]
    : undefined;
const commit = (await commandOutputOrEmpty('git', ['rev-parse', '--short=8', 'HEAD'])) || 'unknown';
const linuxRuntime = linuxTarget
    ? await ensureLinuxRuntime(linuxTarget, runtimeVersion)
    : undefined;
const target: StagingTarget = linuxTarget
    ? {
          arch: linuxTarget,
          linuxNatives: await ensureLinuxNatives(linuxTarget, linuxRuntime!),
          platform: 'linux',
      }
    : { arch: process.arch, platform: process.platform };
let executable: string;
if (linuxRuntime) {
    executable = resolve(root, `.cache/server-linux-target/runtime/node-${linuxTarget}`);
    await extractLinuxNode(linuxRuntime, executable);
} else {
    executable = await runtimeExecutable(runtimeVersion);
}

// Per-target staging keeps a host build and a cross-assembled target build from deleting each other's inputs.
const nativeStageRoot = join(nativeStageRootBase, `${target.platform}-${target.arch}`);
await rm(nativeStageRoot, { force: true, recursive: true });
await mkdir(nativeStageRoot, { recursive: true });
const nativePackages: Array<{ name: string; source: string; version: string }> = await Promise.all(
    directNativePackageNames.map(async (name) => {
        const destination = join(nativeStageRoot, ...name.split('/'));
        return {
            name,
            ...(await stagePackageTree(name, serverRoot, destination, target)),
        };
    }),
);
const ripgrepExecutable = binPathFor({ arch: target.arch, os: target.platform });
const ripgrepPackageRoot = resolve(dirname(ripgrepExecutable), '../..');

const artifactRoot = linuxTarget
    ? resolve(serverRoot, 'dist/targets', `linux-${linuxTarget}`, 'server')
    : resolve(serverRoot, 'dist/server');
const extensions = [
    { id: 'caxri.git', source: resolve(root, 'extensions/git') },
    { id: 'caxri.project-status', source: resolve(root, 'extensions/status') },
];
if (process.env.CAXRI_SERVER_INCLUDE_TEST_EXTENSION === '1') {
    extensions.push({ id: 'caxri.fixture', source: resolve(root, 'extensions/fixture') });
}
/**
 * SSH Host targets carry the `caxri` CLI so remote Terminals and Agents can call it; build it on demand so a fresh
 * checkout can produce a target artifact without a separate step.
 */
async function ensureCliBundle(): Promise<string> {
    const bundle = resolve(root, 'apps/cli/dist/caxri.cjs');
    try {
        await access(bundle);
    } catch {
        await execFileAsync('bun', ['run', 'build:cli'], { cwd: root });
    }
    return bundle;
}

const manifest = await assembleServerArtifact({
    architecture: target.arch,
    artifactRoot,
    bundleSource: resolve(serverRoot, 'dist/bundles'),
    ...(linuxTarget && { cliBundle: await ensureCliBundle(), omitSourceMaps: true }),
    commit,
    extensions,
    migrationsSource: resolve(serverRoot, 'src/domains/db/migrations'),
    nativePackages,
    platform: target.platform,
    protocolVersion: CAXRI_PROTOCOL_VERSION,
    ...(linuxRuntime && {
        runtimeSource: {
            url: linuxRuntime.url,
            sha256: linuxRuntime.sha256,
            member: linuxRuntime.member,
        },
    }),
    ripgrep: {
        executable: ripgrepExecutable,
        ripgrepLicense: resolve(root, 'licenses/RIPGREP_LICENSE.txt'),
        vscodeLicense: join(ripgrepPackageRoot, 'LICENSE'),
    },
    runtime: { executable, version: runtimeVersion },
    version: workspaceManifest.version,
});
await verifyServerArtifact(artifactRoot);
await rm(nativeStageRoot, { force: true, recursive: true });
process.stdout.write(
    `Built standalone Server artifact ${manifest.integrity.aggregateSha256} (${manifest.integrity.files.length} files)\n`,
);
