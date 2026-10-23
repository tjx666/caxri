#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import { serverArtifactManifestSchema } from '@caxri/protocol';

import { execFileAsync, runChildProcess } from './exec';
import type { SourceMapFlavor } from './source-map-flavor';

const RELEASE_OUTPUT_ROOT = 'release.noindex';
const FLAVOR_OUTPUT_DIRECTORY: Record<SourceMapFlavor, string> = {
    include: 'sourcemap',
    omit: 'nosourcemap',
};
const DESKTOP_SOURCE_MAP_ROOTS = ['out/main', 'out/preload', 'out/renderer'] as const;

interface ReleaseDmgArtifact {
    appPath: string;
    assetName: string;
    checksumPath: string;
    dmgPath: string;
    flavor: SourceMapFlavor;
}

function compareCodeUnits(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

async function walkFiles(root: string, current = root): Promise<string[]> {
    const metadata = await lstat(current);
    if (metadata.isFile()) return [current];
    if (!metadata.isDirectory()) return [];
    const entries = (await readdir(current)).toSorted(compareCodeUnits);
    return (
        await Promise.all(entries.map((entry) => walkFiles(root, join(current, entry))))
    ).flat();
}

function sourceMapPaths(root: string, files: readonly string[]): string[] {
    return files
        .filter((path) => path.endsWith('.map'))
        .map((path) => relative(root, path).split(sep).join('/'))
        .toSorted(compareCodeUnits);
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/package-release-dmgs.test.ts
export function assertSourceMapInventory(
    label: string,
    paths: readonly string[],
    flavor: SourceMapFlavor,
): void {
    if (flavor === 'include' && paths.length === 0) {
        throw new Error(`${label} contains no Source Maps for the include flavor.`);
    }
    if (flavor === 'omit' && paths.length > 0) {
        throw new Error(`${label} contains Source Maps for the omit flavor: ${paths.join(', ')}`);
    }
}

async function verifyServerSourceMaps(serverRoot: string, flavor: SourceMapFlavor): Promise<void> {
    const actualMaps = sourceMapPaths(serverRoot, await walkFiles(serverRoot));
    const manifestText = await readFile(join(serverRoot, 'metadata', 'manifest.json'), 'utf8');
    const manifestValue = JSON.parse(manifestText) as unknown;
    const manifest = serverArtifactManifestSchema.parse(manifestValue);
    const receiptMaps = manifest.integrity.files
        .map(({ path }) => path)
        .filter((path) => path.endsWith('.map'))
        .toSorted(compareCodeUnits);
    if (JSON.stringify(receiptMaps) !== JSON.stringify(actualMaps)) {
        throw new Error('The Server manifest Source Map receipts do not match the packaged files.');
    }
    assertSourceMapInventory('Server artifact', actualMaps, flavor);
}

async function verifyBuildSourceMaps(cwd: string, flavor: SourceMapFlavor): Promise<void> {
    const inventories = await Promise.all(
        DESKTOP_SOURCE_MAP_ROOTS.map(async (path) => {
            const root = join(cwd, path);
            return { path, sourceMaps: sourceMapPaths(root, await walkFiles(root)) };
        }),
    );
    for (const { path, sourceMaps } of inventories) {
        assertSourceMapInventory(path, sourceMaps, flavor);
    }
    await verifyServerSourceMaps(join(cwd, 'apps/server/dist/server'), flavor);
}

const ASAR_SOURCE_MAP_SCRIPT = `// 检查已打包 ASAR 中的 Source Map 路径。
const { readdirSync } = require('node:fs');
const { join, relative, sep } = require('node:path');
const root = process.argv[1];
const found = [];
function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && entry.name.endsWith('.map')) {
            found.push(relative(root, path).split(sep).join('/'));
        }
    }
}
walk(root);
process.stdout.write(JSON.stringify(found.sort()));`;

async function packagedAsarSourceMaps(appPath: string): Promise<string[]> {
    const executable = join(appPath, 'Contents', 'MacOS', 'Caxri');
    const asarPath = join(appPath, 'Contents', 'Resources', 'app.asar');
    const { stdout } = await execFileAsync(executable, ['-e', ASAR_SOURCE_MAP_SCRIPT, asarPath], {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed) || parsed.some((path) => typeof path !== 'string')) {
        throw new Error('The packaged application returned an invalid ASAR Source Map inventory.');
    }
    return parsed as string[];
}

function assertPackagedDesktopMaps(paths: readonly string[], flavor: SourceMapFlavor): void {
    if (flavor === 'omit') {
        assertSourceMapInventory('Packaged app.asar', paths, flavor);
        return;
    }
    for (const root of DESKTOP_SOURCE_MAP_ROOTS) {
        const prefix = `${root}/`;
        assertSourceMapInventory(
            `Packaged app.asar ${root}`,
            paths.filter((path) => path.startsWith(prefix)),
            flavor,
        );
    }
}

async function sha256(path: string): Promise<string> {
    const digest = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(path);
        stream.on('data', (chunk) => digest.update(chunk));
        stream.once('error', reject);
        stream.once('end', resolve);
    });
    return digest.digest('hex');
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/package-release-dmgs.test.ts
export function releaseDmgArtifact(
    cwd: string,
    version: string,
    flavor: SourceMapFlavor,
): ReleaseDmgArtifact {
    const suffix = flavor === 'omit' ? '-nosourcemap' : '';
    const assetName = `Caxri-${version}-arm64${suffix}.dmg`;
    const outputDirectory = join(cwd, RELEASE_OUTPUT_ROOT, FLAVOR_OUTPUT_DIRECTORY[flavor]);
    const dmgPath = join(outputDirectory, assetName);
    return {
        appPath: join(outputDirectory, 'mac-arm64', 'Caxri.app'),
        assetName,
        checksumPath: `${dmgPath}.sha256`,
        dmgPath,
        flavor,
    };
}

async function runRequired(
    command: string,
    arguments_: readonly string[],
    cwd: string,
    environment = process.env,
): Promise<void> {
    const exitCode = await runChildProcess(command, arguments_, {
        cwd,
        env: environment,
        stdio: 'inherit',
    });
    if (exitCode !== 0)
        throw new Error(`${command} ${arguments_.join(' ')} exited with ${exitCode}`);
}

async function packageFlavor(
    cwd: string,
    version: string,
    flavor: SourceMapFlavor,
): Promise<ReleaseDmgArtifact> {
    const artifact = releaseDmgArtifact(cwd, version, flavor);
    const outputDirectory = dirname(artifact.dmgPath);
    await rm(outputDirectory, { force: true, recursive: true });
    const environment = { ...process.env, CAXRI_SOURCE_MAPS: flavor };
    await runRequired('bun', ['run', 'build'], cwd, environment);
    await verifyBuildSourceMaps(cwd, flavor);
    // The remote layers use the freshly built Server bundles but are flavor-independent because remote targets always
    // omit Source Maps. Build them once before packaging the first flavor; the second build preserves dist/remote.
    if (flavor === 'include') await runRequired('bun', ['run', 'build:remote-layers'], cwd);
    await runRequired(
        join(cwd, 'node_modules/.bin/electron-builder'),
        [
            '--mac',
            'dmg',
            '--arm64',
            '--publish',
            'never',
            `--config.directories.output=${relative(cwd, outputDirectory)}`,
            `--config.artifactName=${artifact.assetName}`,
        ],
        cwd,
        environment,
    );
    assertPackagedDesktopMaps(await packagedAsarSourceMaps(artifact.appPath), flavor);
    await verifyServerSourceMaps(join(artifact.appPath, 'Contents', 'Resources', 'server'), flavor);
    await runRequired('hdiutil', ['verify', artifact.dmgPath], cwd);
    await writeFile(
        artifact.checksumPath,
        `${await sha256(artifact.dmgPath)}  ${artifact.assetName}\n`,
        'utf8',
    );
    return artifact;
}

async function packageReleaseDmgs(cwd = process.cwd()): Promise<ReleaseDmgArtifact[]> {
    if (process.platform !== 'darwin') throw new Error('macOS release DMGs require macOS.');
    const workspace = resolve(cwd);
    const packageJson = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')) as {
        version?: unknown;
    };
    if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
        throw new Error('package.json is missing a release version.');
    }
    const artifacts: ReleaseDmgArtifact[] = [];
    for (const flavor of ['include', 'omit'] as const) {
        // Each flavor rebuilds both Desktop and Server before packaging into its own output directory.
        // eslint-disable-next-line no-await-in-loop -- sequential builds prevent shared build outputs from crossing flavors
        artifacts.push(await packageFlavor(workspace, packageJson.version, flavor));
    }
    process.stdout.write(
        `${JSON.stringify(
            artifacts.map(({ assetName, checksumPath, dmgPath, flavor }) => ({
                assetName,
                checksumPath: relative(workspace, checksumPath),
                dmgPath: relative(workspace, dmgPath),
                flavor,
            })),
        )}\n`,
    );
    return artifacts;
}

if (import.meta.main) await packageReleaseDmgs();
