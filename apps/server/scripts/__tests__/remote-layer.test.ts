import { execFile } from 'node:child_process';
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    utimes,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { buildAppLayer, REMOTE_CHECKSUMS_FILE, REMOTE_RUNTIME_PATH } from '../remote-layer';
import { parseRemoteTargets } from '../remote-target';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const longPath = `native/node_modules/${'nested-package-directory/'.repeat(5)}build/Release/addon.node`;

async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-remote-layer-'));
    temporaryDirectories.push(directory);
    return directory;
}

async function fixtureFile(path: string, contents: string, mode = 0o644): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
    await chmod(path, mode);
}

async function fixtureArtifact(root: string): Promise<string> {
    const artifact = join(root, 'server');
    await Promise.all([
        fixtureFile(join(artifact, 'bundles', 'server-core.js'), 'core'),
        fixtureFile(join(artifact, 'metadata', 'manifest.json'), '{}'),
        fixtureFile(join(artifact, 'runtime', 'caxri-server'), '#!/bin/sh\n', 0o755),
        fixtureFile(join(artifact, 'runtime', 'bin', 'rg'), 'rg', 0o755),
        fixtureFile(join(artifact, REMOTE_RUNTIME_PATH), 'node runtime', 0o755),
        fixtureFile(join(artifact, longPath), 'addon', 0o755),
        fixtureFile(join(artifact, 'cli', 'caxri.cjs'), 'cli', 0o755),
    ]);
    return artifact;
}

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
});

describe('remote application layer', () => {
    it('archives every file except the runtime with a verifiable SHA256SUMS and executable bits', async () => {
        const root = await temporaryDirectory();
        const artifact = await fixtureArtifact(root);
        const archive = join(root, 'app.tar.gz');
        const result = await buildAppLayer(artifact, archive);

        expect(result.files).toBe(6);
        expect(result.bytes).toBe((await lstat(archive)).size);
        const extracted = join(root, 'extracted');
        await mkdir(extracted);
        await execFileAsync('tar', ['-xzf', archive, '-C', extracted]);

        await expect(lstat(join(extracted, REMOTE_RUNTIME_PATH))).rejects.toThrow();
        const checksums = await readFile(join(extracted, REMOTE_CHECKSUMS_FILE), 'utf8');
        expect(checksums).not.toContain(REMOTE_RUNTIME_PATH);
        expect(checksums).not.toContain(`  ${REMOTE_CHECKSUMS_FILE}\n`);
        expect(checksums.trimEnd().split('\n')).toHaveLength(6);
        // `shasum -a 256 -c` reads the exact `sha256sum -c` format an SSH Host verifies.
        await execFileAsync('shasum', ['-a', '256', '-c', REMOTE_CHECKSUMS_FILE], {
            cwd: extracted,
        });
        expect((await lstat(join(extracted, 'runtime', 'caxri-server'))).mode & 0o111).not.toBe(0);
        expect((await lstat(join(extracted, longPath))).mode & 0o777).toBe(0o755);
        expect((await lstat(join(extracted, 'bundles', 'server-core.js'))).mode & 0o777).toBe(
            0o644,
        );

        const { stdout } = await execFileAsync('tar', ['--numeric-owner', '-tvzf', archive]);
        const lines = stdout.trim().split('\n');
        expect(lines[0]).toContain(REMOTE_CHECKSUMS_FILE);
        expect(lines.every((line) => /\s0\s+0\s/u.test(line))).toBe(true);
        expect(stdout).not.toContain('._');
    });

    it('produces identical bytes regardless of source timestamps', async () => {
        const root = await temporaryDirectory();
        const artifact = await fixtureArtifact(root);
        const first = await buildAppLayer(artifact, join(root, 'first.tar.gz'));
        await utimes(join(artifact, 'bundles', 'server-core.js'), 1_000, 2_000);
        const second = await buildAppLayer(artifact, join(root, 'second.tar.gz'));

        expect(second.sha256).toBe(first.sha256);
        const header = await readFile(join(root, 'first.tar.gz'));
        expect(header.readUInt32LE(4)).toBe(0);
        expect(header[9]).toBe(3);
    });

    it('refuses symbolic links', async () => {
        const root = await temporaryDirectory();
        const artifact = await fixtureArtifact(root);
        await symlink('server-core.js', join(artifact, 'bundles', 'alias.js'));

        await expect(buildAppLayer(artifact, join(root, 'app.tar.gz'))).rejects.toThrow(
            'not a regular file',
        );
    });
});

describe('remote target arguments', () => {
    const appleSilicon = { arch: 'arm64', platform: 'darwin' as const };
    const linuxHost = { arch: 'x64', platform: 'linux' as const };

    it('defaults to both Linux targets, plus darwin-arm64 only on an Apple silicon host', () => {
        expect(parseRemoteTargets([], appleSilicon)).toEqual([
            'linux-x64',
            'linux-arm64',
            'darwin-arm64',
        ]);
        expect(parseRemoteTargets([], linuxHost)).toEqual(['linux-x64', 'linux-arm64']);
        expect(parseRemoteTargets([], { arch: 'x64', platform: 'darwin' })).toEqual([
            'linux-x64',
            'linux-arm64',
        ]);
    });

    it('validates explicit targets', () => {
        expect(parseRemoteTargets(['--target', 'linux-arm64'], linuxHost)).toEqual(['linux-arm64']);
        expect(parseRemoteTargets(['--target', 'darwin-arm64'], appleSilicon)).toEqual([
            'darwin-arm64',
        ]);
        expect(() => parseRemoteTargets(['--target', 'linux-riscv64'], linuxHost)).toThrow(
            'Unsupported --target linux-riscv64',
        );
        expect(() => parseRemoteTargets(['--target', 'darwin-x64'], appleSilicon)).toThrow(
            'Unsupported --target darwin-x64',
        );
        expect(() => parseRemoteTargets(['--target', 'darwin-arm64'], linuxHost)).toThrow(
            'needs an Apple silicon Mac',
        );
    });
});
