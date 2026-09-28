#!/usr/bin/env bun

/**
 * Provisions the pinned `gitleaks` binary for local hooks and both CI surfaces: the self-hosted macOS runner and the
 * GitHub-hosted Linux `guards` job. Neither has a package manager that ships gitleaks (no Homebrew, no mise, no npm
 * package), so this repository owns the download the same way `electron:install` and Playwright's browser install
 * already own their own binaries. A local machine that already has the pinned version on `PATH` (the common case: it is
 * installed there via Homebrew) skips the network round trip entirely.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { runChildProcess } from './exec';

const execFileAsync = promisify(execFile);

/**
 * The release tarball is a few megabytes; buffering it fully avoids depending on any Bun-specific streaming API (this
 * script runs under `bun run` but is typechecked and Vitest-imported under plain Node, where `Bun` is not global) while
 * still bounding a malformed or redirected response.
 */
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

/**
 * Pinned to the exact version `.gitleaks.toml`'s allowlists were authored and verified against (see that file's
 * header). Bump deliberately, together with a re-verification that the full working-tree and git-history scans still
 * report zero findings, and refresh `RELEASE_CHECKSUMS` from that release's own `gitleaks_<version>_checksums.txt`. Not
 * exported: every test drives `resolveGitleaksBinary` through its explicit `version`/`checksums` overrides instead, so
 * this default only matters to this file's own `main()`.
 */
const GITLEAKS_VERSION = '8.30.1';

/**
 * Sha256 checksums copied verbatim from the pinned release's published checksums file
 * (https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1), so a corrupted or tampered download fails closed instead
 * of silently running an unverified binary. Caxri ships macOS builds (see stack-baseline's target platform) and also
 * runs this script on the Linux-hosted `guards` CI job (`.github/workflows/guards.yml`), so both Mac architectures and
 * both Linux architectures are pinned. Not exported: see `GITLEAKS_VERSION`'s comment above.
 */
const GITLEAKS_RELEASE_CHECKSUMS: Readonly<Record<string, string>> = Object.freeze({
    'darwin-arm64': 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
    'darwin-x64': 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
    'linux-arm64': 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
    'linux-x64': '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
});

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/prepare-gitleaks.test.ts
export interface GitleaksReleaseTarget {
    arch: string;
    platform: NodeJS.Platform;
}

/**
 * Maps a Node platform/arch pair to this repository's release-checksum key, failing closed on an unsupported
 * combination instead of silently skipping verification.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/prepare-gitleaks.test.ts
export function gitleaksReleaseKey({ arch, platform }: GitleaksReleaseTarget): string {
    if (platform !== 'darwin' && platform !== 'linux') {
        throw new Error(`Unsupported platform for gitleaks provisioning: ${platform}`);
    }
    if (arch !== 'arm64' && arch !== 'x64') {
        throw new Error(`Unsupported architecture for gitleaks provisioning: ${arch}`);
    }
    return `${platform}-${arch}`;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/prepare-gitleaks.test.ts
export function gitleaksReleaseAssetName(releaseKey: string, version: string): string {
    const [platform, arch] = releaseKey.split('-', 2);
    return `gitleaks_${version}_${platform}_${arch}.tar.gz`;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/gitleaks-scan.ts and scripts/__tests__/prepare-gitleaks.test.ts
export interface GitleaksPreparationOptions {
    arch?: string;
    /**
     * Root directory that owns every cached tool version, matching the CI `$RUNNER_TOOL_CACHE/caxri` convention.
     */
    cacheRoot: string;
    checksums?: Readonly<Record<string, string>>;
    downloadFile?: (url: string, destinationPath: string) => Promise<void>;
    platform?: NodeJS.Platform;
    version?: string;
}

async function isReadyBinary(binaryPath: string, expectedVersion: string): Promise<boolean> {
    try {
        if (!(await stat(binaryPath)).isFile()) return false;
    } catch {
        return false;
    }
    try {
        const { stdout } = await execFileAsync(binaryPath, ['version']);
        return stdout.trim() === expectedVersion;
    } catch {
        return false;
    }
}

/**
 * A machine that already has the exact pinned version reachable on `PATH` (the maintainer's own Homebrew install,
 * today) never needs the cached or downloaded copy. This keeps every local `git commit` fast and offline in the common
 * case. Not exported: every test supplies a cache-hit or cache-miss fixture instead of exercising this "already on
 * PATH" branch directly.
 */
async function pathGitleaksBinary(expectedVersion: string): Promise<string | undefined> {
    return (await isReadyBinary('gitleaks', expectedVersion)) ? 'gitleaks' : undefined;
}

async function defaultDownloadFile(url: string, destinationPath: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_ARCHIVE_BYTES) {
        throw new Error(`gitleaks download exceeded ${MAX_ARCHIVE_BYTES} bytes: ${url}`);
    }
    await writeFile(destinationPath, new Uint8Array(body));
}

async function verifyChecksum(archivePath: string, expectedChecksum: string): Promise<void> {
    const digest = createHash('sha256')
        .update(await readFile(archivePath))
        .digest('hex');
    if (digest !== expectedChecksum) {
        throw new Error(
            `gitleaks download checksum mismatch: expected ${expectedChecksum}, got ${digest}`,
        );
    }
}

/**
 * Resolves the absolute path of the pinned gitleaks binary, downloading and checksum-verifying it into
 * `<cacheRoot>/gitleaks/<version>/` on a cache miss. Extraction only unpacks the single `gitleaks` executable (the
 * release tarball also carries `LICENSE`/`README.md`, which this repository does not need to keep or trust).
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/gitleaks-scan.ts and scripts/__tests__/prepare-gitleaks.test.ts
export async function resolveGitleaksBinary(options: GitleaksPreparationOptions): Promise<string> {
    const version = options.version ?? GITLEAKS_VERSION;
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    const checksums = options.checksums ?? GITLEAKS_RELEASE_CHECKSUMS;
    const downloadFile = options.downloadFile ?? defaultDownloadFile;

    const onPath = await pathGitleaksBinary(version);
    if (onPath) return onPath;

    const releaseKey = gitleaksReleaseKey({ arch, platform });
    const expectedChecksum = checksums[releaseKey];
    if (!expectedChecksum) throw new Error(`No pinned gitleaks checksum for ${releaseKey}`);

    const versionDirectory = join(options.cacheRoot, 'gitleaks', version);
    const binaryPath = join(versionDirectory, 'gitleaks');
    if (await isReadyBinary(binaryPath, version)) return binaryPath;

    await mkdir(versionDirectory, { recursive: true });
    const assetName = gitleaksReleaseAssetName(releaseKey, version);
    const downloadDirectory = await mkdtemp(join(tmpdir(), 'caxri-gitleaks-'));
    const archivePath = join(downloadDirectory, assetName);
    try {
        const downloadUrl = `https://github.com/gitleaks/gitleaks/releases/download/v${version}/${assetName}`;
        await downloadFile(downloadUrl, archivePath);
        await verifyChecksum(archivePath, expectedChecksum);
        const extractResult = await runChildProcess('tar', [
            '-xzf',
            archivePath,
            '-C',
            versionDirectory,
            'gitleaks',
        ]);
        if (extractResult !== 0) throw new Error(`tar exited with code ${extractResult}`);
        await chmod(binaryPath, 0o755);
    } finally {
        await rm(downloadDirectory, { force: true, recursive: true });
    }

    if (!(await isReadyBinary(binaryPath, version))) {
        throw new Error(`gitleaks did not extract a runnable v${version} binary at ${binaryPath}`);
    }
    return binaryPath;
}

async function main(): Promise<void> {
    const cacheRoot = process.env.RUNNER_TOOL_CACHE
        ? join(process.env.RUNNER_TOOL_CACHE, 'caxri')
        : join(import.meta.dirname, '..', '.cache', 'tool-cache');
    const binaryPath = await resolveGitleaksBinary({ cacheRoot });
    process.stdout.write(`${binaryPath}\n`);
}

if (import.meta.main) await main();
