import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { execFileAsync } from '../exec';
import {
    gitleaksReleaseAssetName,
    gitleaksReleaseKey,
    resolveGitleaksBinary,
} from '../prepare-gitleaks';

/**
 * A version string no real installed gitleaks would ever report, so `resolveGitleaksBinary`'s "already on PATH" fast
 * path never masks the cache-directory behavior under test, regardless of whether the machine running these tests
 * happens to have gitleaks installed.
 */
const FAKE_VERSION = '9.9.9-fixture';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { force: true, recursive: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

/**
 * A tiny fake "gitleaks" executable that only implements `version`, for offline extraction fixtures.
 */
function fakeBinaryScript(version: string): string {
    return `#!/bin/sh\nif [ "$1" = "version" ]; then echo "${version}"; fi\n`;
}

async function buildFixtureArchive(archivePath: string, version: string): Promise<void> {
    const sourceDirectory = await temporaryDirectory('caxri-gitleaks-fixture-source-');
    const binaryPath = join(sourceDirectory, 'gitleaks');
    await writeFile(binaryPath, fakeBinaryScript(version));
    await chmod(binaryPath, 0o755);
    await execFileAsync('tar', ['-czf', archivePath, '-C', sourceDirectory, 'gitleaks']);
}

describe('gitleaksReleaseKey', () => {
    it('resolves the two Mac architectures Caxri ships', () => {
        expect(gitleaksReleaseKey({ arch: 'arm64', platform: 'darwin' })).toBe('darwin-arm64');
        expect(gitleaksReleaseKey({ arch: 'x64', platform: 'darwin' })).toBe('darwin-x64');
    });

    it('resolves the two Linux architectures the guards CI job runs on', () => {
        expect(gitleaksReleaseKey({ arch: 'arm64', platform: 'linux' })).toBe('linux-arm64');
        expect(gitleaksReleaseKey({ arch: 'x64', platform: 'linux' })).toBe('linux-x64');
    });

    it('fails closed on an unsupported platform instead of silently skipping verification', () => {
        expect(() => gitleaksReleaseKey({ arch: 'x64', platform: 'win32' })).toThrow(
            /Unsupported platform/,
        );
    });

    it('fails closed on an unsupported architecture', () => {
        expect(() => gitleaksReleaseKey({ arch: 'ia32', platform: 'darwin' })).toThrow(
            /Unsupported architecture/,
        );
    });
});

describe('gitleaksReleaseAssetName', () => {
    it('matches the published release tarball naming', () => {
        expect(gitleaksReleaseAssetName('darwin-arm64', '8.30.1')).toBe(
            'gitleaks_8.30.1_darwin_arm64.tar.gz',
        );
    });
});

describe('resolveGitleaksBinary', () => {
    it('reuses an already-cached binary without downloading again', async () => {
        const cacheRoot = await temporaryDirectory('caxri-gitleaks-cache-hit-');
        const versionDirectory = join(cacheRoot, 'gitleaks', FAKE_VERSION);
        await mkdir(versionDirectory, { recursive: true });
        const cachedBinary = join(versionDirectory, 'gitleaks');
        await writeFile(cachedBinary, fakeBinaryScript(FAKE_VERSION));
        await chmod(cachedBinary, 0o755);

        const downloadFile = vi.fn();
        await expect(
            resolveGitleaksBinary({ cacheRoot, downloadFile, version: FAKE_VERSION }),
        ).resolves.toBe(cachedBinary);
        expect(downloadFile).not.toHaveBeenCalled();
    });

    it('downloads, verifies, and extracts on a cache miss', async () => {
        const cacheRoot = await temporaryDirectory('caxri-gitleaks-happy-path-');
        const fixtureDirectory = await temporaryDirectory('caxri-gitleaks-fixture-archive-');
        const fixtureArchive = join(fixtureDirectory, 'fixture.tar.gz');
        await buildFixtureArchive(fixtureArchive, FAKE_VERSION);
        const expectedChecksum = createHash('sha256')
            .update(await readFile(fixtureArchive))
            .digest('hex');

        const downloadFile = vi.fn(async (_url: string, destinationPath: string) => {
            await writeFile(destinationPath, await readFile(fixtureArchive));
        });

        const binaryPath = await resolveGitleaksBinary({
            arch: 'arm64',
            cacheRoot,
            checksums: { 'darwin-arm64': expectedChecksum },
            downloadFile,
            platform: 'darwin',
            version: FAKE_VERSION,
        });

        expect(binaryPath).toBe(join(cacheRoot, 'gitleaks', FAKE_VERSION, 'gitleaks'));
        expect(downloadFile).toHaveBeenCalledOnce();
        expect(downloadFile.mock.calls[0]?.[0]).toBe(
            `https://github.com/gitleaks/gitleaks/releases/download/v${FAKE_VERSION}/gitleaks_${FAKE_VERSION}_darwin_arm64.tar.gz`,
        );
        expect((await stat(binaryPath)).mode & 0o777).toBe(0o755);
        const { stdout } = await execFileAsync(binaryPath, ['version']);
        expect(stdout.trim()).toBe(FAKE_VERSION);
    });

    it('fails closed and leaves no binary behind when the checksum does not match', async () => {
        const cacheRoot = await temporaryDirectory('caxri-gitleaks-checksum-mismatch-');
        const downloadFile = vi.fn(async (_url: string, destinationPath: string) => {
            await writeFile(destinationPath, 'not the real archive');
        });

        await expect(
            resolveGitleaksBinary({
                arch: 'arm64',
                cacheRoot,
                checksums: { 'darwin-arm64': '0'.repeat(64) },
                downloadFile,
                platform: 'darwin',
                version: FAKE_VERSION,
            }),
        ).rejects.toThrow(/checksum mismatch/);

        await expect(stat(join(cacheRoot, 'gitleaks', FAKE_VERSION, 'gitleaks'))).rejects.toThrow();
    });

    it('fails closed when no checksum is pinned for the target platform', async () => {
        const cacheRoot = await temporaryDirectory('caxri-gitleaks-no-checksum-');
        const downloadFile = vi.fn();
        await expect(
            resolveGitleaksBinary({
                arch: 'x64',
                cacheRoot,
                checksums: {},
                downloadFile,
                platform: 'darwin',
                version: FAKE_VERSION,
            }),
        ).rejects.toThrow(/No pinned gitleaks checksum/);
        expect(downloadFile).not.toHaveBeenCalled();
    });
});
