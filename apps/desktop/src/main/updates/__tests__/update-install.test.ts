import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, dialog: {} }));

const {
    appBundlePath,
    collectInPlaceInstallReport,
    IN_PLACE_INSTALL_SCRIPT,
    inPlaceInstallPaths,
    launchInPlaceInstall,
    resolveInPlaceInstallTarget,
    stageUpdateBundle,
} = await import('../update-install');

const directories: string[] = [];

async function scratch(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-update-install-test-'));
    directories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
    directories.length = 0;
});

/**
 * A bundle-shaped directory whose only content is a marker naming its version, enough to tell which bundle ended up
 * where after the script ran.
 */
async function fakeBundle(path: string, version: string): Promise<void> {
    await mkdir(join(path, 'Contents', 'MacOS'), { recursive: true });
    await writeFile(join(path, 'Contents', 'version'), version);
}

function runScript(arguments_: readonly string[]): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const child = spawn('/bin/sh', ['-c', IN_PLACE_INSTALL_SCRIPT, 'test', ...arguments_], {
            stdio: 'ignore',
        });
        child.on('error', reject);
        child.on('close', resolve);
    });
}

/**
 * A PID that is certainly not running: a child that has already exited.
 */
async function exitedPid(): Promise<number> {
    const child = spawn('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' });
    await new Promise((resolve) => child.on('close', resolve));
    return child.pid!;
}

describe('appBundlePath', () => {
    it('finds the bundle around a macOS executable', () => {
        expect(appBundlePath('/Applications/Caxri.app/Contents/MacOS/Caxri')).toBe(
            '/Applications/Caxri.app',
        );
    });

    it('rejects paths that are not inside a bundle', () => {
        expect(appBundlePath('/usr/local/bin/caxri')).toBeUndefined();
        expect(appBundlePath('/opt/Caxri/Contents/MacOS/Caxri')).toBeUndefined();
    });
});

describe('resolveInPlaceInstallTarget', () => {
    it('allows a packaged macOS app in a writable folder', async () => {
        const root = await scratch();
        const bundle = join(root, 'Caxri.app');
        await fakeBundle(bundle, '1.0.0');

        await expect(
            resolveInPlaceInstallTarget({
                executablePath: join(bundle, 'Contents', 'MacOS', 'Caxri'),
                isPackaged: true,
                platform: 'darwin',
            }),
        ).resolves.toEqual({ kind: 'available', bundlePath: bundle });
    });

    it('names why each other install falls back to the DMG', async () => {
        const executablePath = '/Applications/Caxri.app/Contents/MacOS/Caxri';
        await expect(
            resolveInPlaceInstallTarget({ executablePath, isPackaged: false, platform: 'darwin' }),
        ).resolves.toEqual({ kind: 'unavailable', reason: 'unpackaged' });
        await expect(
            resolveInPlaceInstallTarget({ executablePath, isPackaged: true, platform: 'linux' }),
        ).resolves.toEqual({ kind: 'unavailable', reason: 'platform' });
        await expect(
            resolveInPlaceInstallTarget({
                executablePath: '/Volumes/Caxri/Caxri.app/Contents/MacOS/Caxri',
                isPackaged: true,
                platform: 'darwin',
            }),
        ).resolves.toEqual({ kind: 'unavailable', reason: 'transient-location' });
    });

    it('falls back when the folder holding the app is read-only', async () => {
        const root = await scratch();
        const parent = join(root, 'locked');
        const bundle = join(parent, 'Caxri.app');
        await fakeBundle(bundle, '1.0.0');
        await chmod(parent, 0o555);
        try {
            await expect(
                resolveInPlaceInstallTarget({
                    executablePath: join(bundle, 'Contents', 'MacOS', 'Caxri'),
                    isPackaged: true,
                    platform: 'darwin',
                }),
            ).resolves.toEqual({ kind: 'unavailable', reason: 'not-writable' });
        } finally {
            await chmod(parent, 0o755);
        }
    });
});

describe('stageUpdateBundle', () => {
    function plistRunner(values: {
        identifier: string;
        installedIdentifier: string;
        version: string;
    }) {
        const calls: string[] = [];
        const run = vi.fn(async (file: string, arguments_: readonly string[]) => {
            calls.push(file.split('/').at(-1)!);
            if (file.endsWith('hdiutil') && arguments_[0] === 'attach') {
                // Pretend the image mounted one app.
                const mountPoint = arguments_[arguments_.indexOf('-mountpoint') + 1];
                await mkdir(join(mountPoint, 'Caxri.app'));
                return '';
            }
            if (file.endsWith('ditto')) {
                const executable = join(arguments_[1], 'Contents', 'MacOS', 'Caxri');
                await mkdir(dirname(executable), { recursive: true });
                await writeFile(executable, '', { mode: 0o755 });
                return '';
            }
            if (file.endsWith('PlistBuddy')) {
                const key = arguments_[1];
                if (key.includes('CFBundleExecutable')) return 'Caxri\n';
                const isInstalled = !arguments_[2].includes('staged');
                if (key.includes('CFBundleIdentifier'))
                    return `${isInstalled ? values.installedIdentifier : values.identifier}\n`;
                return `${values.version}\n`;
            }
            return '';
        });
        return { calls, run };
    }

    it('unpacks the app, detaches the image, and checks the copy', async () => {
        const root = await scratch();
        const { calls, run } = plistRunner({
            identifier: 'dev.caxri.app',
            installedIdentifier: 'dev.caxri.app',
            version: '2.0.0',
        });

        const staged = await stageUpdateBundle({
            bundlePath: join(root, 'Applications', 'Caxri.app'),
            dmgPath: join(root, 'Caxri-2.0.0.dmg'),
            run,
            stagingDirectory: join(root, 'staged'),
            version: '2.0.0',
        });

        expect(staged).toBe(join(root, 'staged', 'Caxri.app'));
        expect(calls).toEqual([
            'hdiutil',
            'ditto',
            'hdiutil',
            'PlistBuddy',
            'PlistBuddy',
            'PlistBuddy',
            'PlistBuddy',
        ]);
    });

    it('rejects a copy whose version or identity does not match', async () => {
        const root = await scratch();
        const input = {
            bundlePath: join(root, 'Applications', 'Caxri.app'),
            dmgPath: join(root, 'Caxri-2.0.0.dmg'),
            stagingDirectory: join(root, 'staged'),
            version: '2.0.0',
        };

        await expect(
            stageUpdateBundle({
                ...input,
                run: plistRunner({
                    identifier: 'dev.caxri.app',
                    installedIdentifier: 'dev.caxri.app',
                    version: '1.9.0',
                }).run,
            }),
        ).rejects.toThrow('version 1.9.0');
        await expect(
            stageUpdateBundle({
                ...input,
                run: plistRunner({
                    identifier: 'dev.other.app',
                    installedIdentifier: 'dev.caxri.app',
                    version: '2.0.0',
                }).run,
            }),
        ).rejects.toThrow('different app');
    });
});

describe('the in-place install script', () => {
    async function layout() {
        const root = await scratch();
        const target = join(root, 'Applications', 'Caxri.app');
        const staged = join(root, 'updates', 'staged', 'Caxri.app');
        const paths = inPlaceInstallPaths(join(root, 'updates'), 'Caxri.app');
        await fakeBundle(target, 'old');
        await fakeBundle(staged, 'new');
        return { paths, staged, target };
    }

    it('replaces the installed bundle and keeps the old one aside', async () => {
        const { paths, staged, target } = await layout();

        const code = await runScript([
            String(await exitedPid()),
            target,
            staged,
            paths.backupPath,
            paths.resultPath,
            '0',
        ]);

        expect(code).toBe(0);
        expect(await readFile(join(target, 'Contents', 'version'), 'utf8')).toBe('new');
        expect(await readFile(join(paths.backupPath, 'Contents', 'version'), 'utf8')).toBe('old');
        expect((await readFile(paths.resultPath, 'utf8')).trim()).toBe('installed');
    });

    it('restores the installed bundle when the new one cannot be moved in', async () => {
        const { paths, target } = await layout();

        const code = await runScript([
            String(await exitedPid()),
            target,
            join(target, '..', 'missing.app'),
            paths.backupPath,
            paths.resultPath,
            '0',
        ]);

        expect(code).toBe(1);
        expect(await readFile(join(target, 'Contents', 'version'), 'utf8')).toBe('old');
        expect((await readFile(paths.resultPath, 'utf8')).trim()).toBe('move-in-failed');
    });
});

describe('launchInPlaceInstall and collectInPlaceInstallReport', () => {
    it('records the pending install, hands the script its arguments, and reads the outcome next launch', async () => {
        const root = await scratch();
        const updatesDirectory = join(root, 'updates');
        await mkdir(updatesDirectory, { recursive: true });
        const spawnDetached = vi.fn();

        await launchInPlaceInstall({
            bundlePath: '/Applications/Caxri.app',
            fromVersion: '1.0.0',
            pid: 42,
            relaunch: true,
            spawnDetached,
            stagedPath: join(updatesDirectory, 'staged', 'Caxri.app'),
            toVersion: '2.0.0',
            updatesDirectory,
        });

        const paths = inPlaceInstallPaths(updatesDirectory, 'Caxri.app');
        expect(spawnDetached).toHaveBeenCalledWith('/bin/sh', [
            '-c',
            IN_PLACE_INSTALL_SCRIPT,
            'caxri-update-install',
            '42',
            '/Applications/Caxri.app',
            join(updatesDirectory, 'staged', 'Caxri.app'),
            paths.backupPath,
            paths.resultPath,
            '1',
        ]);

        await fakeBundle(paths.backupPath, 'old');
        await writeFile(paths.resultPath, 'installed\n');
        await expect(collectInPlaceInstallReport(updatesDirectory, 'Caxri.app')).resolves.toEqual({
            from: '1.0.0',
            outcome: 'installed',
            to: '2.0.0',
        });
        // The record and the kept-aside bundle are gone, so the report is read once.
        expect(await readdir(updatesDirectory)).toEqual([]);
        await expect(
            collectInPlaceInstallReport(updatesDirectory, 'Caxri.app'),
        ).resolves.toBeUndefined();
    });

    it('reports a pending install whose script never recorded a result', async () => {
        const root = await scratch();
        const paths = inPlaceInstallPaths(root, 'Caxri.app');
        await writeFile(paths.pendingPath, JSON.stringify({ from: '1.0.0', to: '2.0.0' }));

        await expect(collectInPlaceInstallReport(root, 'Caxri.app')).resolves.toEqual({
            from: '1.0.0',
            outcome: 'missing',
            to: '2.0.0',
        });
    });
});
