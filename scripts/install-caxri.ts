#!/usr/bin/env bun

/**
 * Install or upgrade the released Caxri app into /Applications without tripping Gatekeeper.
 *
 * The published DMG is unsigned and unnotarized, so a browser download gets a `com.apple.quarantine` flag and macOS
 * reports the app as "damaged". Terminal downloads through `gh` never receive that flag, so this installer downloads
 * the requested release (latest by default), verifies the SHA-256 checksum, mounts the DMG, replaces
 * /Applications/Caxri.app, and defensively strips any quarantine attribute afterwards.
 *
 * Usage: `bun run install:caxri [-- --tag v0.0.7]`
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { execFileAsync } from './exec';

const REPOSITORY = 'tjx666/caxri';
const INSTALL_PATH = '/Applications/Caxri.app';

interface InstallOptions {
    tag?: string;
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/install-caxri.test.ts
export function parseArguments(argv: string[]): InstallOptions {
    const options: InstallOptions = {};
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        const next = argv.at(index + 1);
        if (argument === '--tag' && next !== undefined) {
            options.tag = next;
            index += 1;
            continue;
        }
        throw new Error(`Unknown argument: ${argument}. Usage: install-caxri [--tag vX.Y.Z]`);
    }
    return options;
}

/**
 * Picks the DMG artifact and its checksum companion out of a downloaded release directory.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/install-caxri.test.ts
export function findDmgPair(names: string[]): { checksum?: string; dmg: string } | undefined {
    const dmg = names.find((name) => name.endsWith('.dmg'));
    if (!dmg) return undefined;
    const checksum = names.find((name) => name === `${dmg}.sha256`);
    return { checksum, dmg };
}

async function isCaxriRunning(): Promise<boolean> {
    try {
        await execFileAsync('pgrep', ['-f', `${INSTALL_PATH}/Contents/MacOS/`]);
        return true;
    } catch {
        return false;
    }
}

/**
 * Politely quits a running installed Caxri before the bundle is replaced; replacing a live app can corrupt its running
 * state.
 */
async function quitRunningCaxri(): Promise<void> {
    if (!(await isCaxriRunning())) return;
    console.log('Quitting the running Caxri…');
    await execFileAsync('osascript', ['-e', 'tell application "Caxri" to quit']);
    for (let attempt = 0; attempt < 20; attempt++) {
        // eslint-disable-next-line no-await-in-loop -- bounded wait for the app to exit
        if (!(await isCaxriRunning())) return;
        // eslint-disable-next-line no-await-in-loop -- bounded wait for the app to exit
        await sleep(500);
    }
    throw new Error('Caxri is still running. Quit it manually and re-run the installer.');
}

async function main(): Promise<void> {
    if (process.platform !== 'darwin') throw new Error('The Caxri installer is macOS-only.');
    const options = parseArguments(process.argv.slice(2));

    const downloadDirectory = await mkdtemp(join(tmpdir(), 'caxri-install-'));
    let mountPoint: string | undefined;
    try {
        const downloadArguments = [
            'release',
            'download',
            ...(options.tag ? [options.tag] : []),
            '--repo',
            REPOSITORY,
            '--pattern',
            '*.dmg',
            '--pattern',
            '*.dmg.sha256',
            '--dir',
            downloadDirectory,
        ];
        console.log(`Downloading ${options.tag ?? 'the latest release'} from ${REPOSITORY}…`);
        await execFileAsync('gh', downloadArguments, { timeout: 600_000 });

        const pair = findDmgPair(await readdir(downloadDirectory));
        if (!pair) throw new Error('The release download produced no DMG.');
        if (pair.checksum) {
            await execFileAsync('shasum', ['-a', '256', '-c', pair.checksum], {
                cwd: downloadDirectory,
            });
            console.log('Checksum verified.');
        }

        const { stdout: attachOut } = await execFileAsync('hdiutil', [
            'attach',
            join(downloadDirectory, pair.dmg),
            '-nobrowse',
            '-readonly',
            '-mountrandom',
            downloadDirectory,
        ]);
        mountPoint = attachOut.match(/\/\S*\/dmg\.\S+/u)?.[0];
        if (!mountPoint) throw new Error(`Could not determine the DMG mount point: ${attachOut}`);

        await quitRunningCaxri();
        await rm(INSTALL_PATH, { force: true, recursive: true });
        await execFileAsync('ditto', [join(mountPoint, 'Caxri.app'), INSTALL_PATH]);
        try {
            // gh downloads carry no quarantine flag, but strip defensively in case the tooling changes.
            await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', INSTALL_PATH]);
        } catch {
            // A missing attribute is the expected case; installation already succeeded.
        }

        const { stdout: version } = await execFileAsync('defaults', [
            'read',
            `${INSTALL_PATH}/Contents/Info`,
            'CFBundleShortVersionString',
        ]);
        console.log(`Installed Caxri ${version.trim()} at ${INSTALL_PATH}.`);
    } finally {
        try {
            if (mountPoint) await execFileAsync('hdiutil', ['detach', mountPoint]);
        } catch {
            // Best-effort unmount; the temporary mount disappears on reboot at worst.
        }
        await rm(downloadDirectory, { force: true, recursive: true });
    }
}

if (import.meta.main) {
    await main();
}
