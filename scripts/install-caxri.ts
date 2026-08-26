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

const EXECUTABLE_PREFIX = `${INSTALL_PATH}/Contents/MacOS/`;
const SERVER_RUNTIME_PREFIX = `${INSTALL_PATH}/Contents/Resources/server/runtime/bin/node`;
const QUIT_POLL_INTERVAL_MS = 500;
const APPLE_EVENT_ATTEMPTS = 10;
const SIGNAL_ATTEMPTS = 10;

interface CaxriProcess {
    command: string;
    pid: number;
}

interface QuitOperations {
    /**
     * Lists the installed Desktop and standalone Server artifact processes.
     */
    list: () => Promise<CaxriProcess[]>;
    quitApplication: () => Promise<void>;
    signalProcess: (pid: number, signal: NodeJS.Signals) => void;
    wait: (milliseconds: number) => Promise<void>;
}

/**
 * Distinguishes standalone Server artifact processes from the windowed Desktop application.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/install-caxri.test.ts
export function isHeadlessCaxriProcess(command: string): boolean {
    return /\/Contents\/Resources\/server\/runtime\/bin\/node\s+\S*\/server\/bundles\/[\w-]+\.js\b/u.test(
        command,
    );
}

async function listInstalledCaxriProcesses(): Promise<CaxriProcess[]> {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,command=']);
    return stdout.split('\n').flatMap((line) => {
        const match = /^\s*(?<pid>\d+)\s+(?<command>\S.*)$/u.exec(line);
        const command = match?.groups?.command;
        if (!command?.startsWith(EXECUTABLE_PREFIX) && !command?.startsWith(SERVER_RUNTIME_PREFIX))
            return [];
        return [{ command, pid: Number(match?.groups?.pid) }];
    });
}

const defaultQuitOperations: QuitOperations = {
    list: listInstalledCaxriProcesses,
    quitApplication: async () => {
        await execFileAsync('osascript', ['-e', 'tell application "Caxri" to quit']);
    },
    signalProcess: (pid, signal) => {
        try {
            process.kill(pid, signal);
        } catch {
            // The process exited between the listing and the signal; that is the outcome we wanted.
        }
    },
    wait: (milliseconds) => sleep(milliseconds),
};

/**
 * Stops everything running out of the installed bundle before it is replaced; `ditto` over a live app corrupts both the
 * bundle and the running process.
 *
 * The windowed application is asked to quit through an Apple event so it can close its windows normally. The Host and
 * Runtime are deliberately detached background processes that outlive every window and are not registered applications,
 * so `tell application "Caxri" to quit` never reaches them — an installer run started after the last window closed used
 * to send an Apple event nothing received, wait out the full timeout, and fail with "quit it manually" against
 * processes that have no UI to quit. They are signalled directly instead, exactly as `uninstall-caxri` stops an owned
 * Host.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/install-caxri.test.ts
export async function quitRunningCaxri(
    operations: QuitOperations = defaultQuitOperations,
): Promise<void> {
    let running = await operations.list();
    if (running.length === 0) return;
    console.log('Quitting the running Caxri…');

    if (running.some(({ command }) => !isHeadlessCaxriProcess(command))) {
        await operations.quitApplication();
        for (let attempt = 0; attempt < APPLE_EVENT_ATTEMPTS && running.length > 0; attempt++) {
            // eslint-disable-next-line no-await-in-loop -- bounded wait for the windowed app to exit
            await operations.wait(QUIT_POLL_INTERVAL_MS);
            // eslint-disable-next-line no-await-in-loop -- bounded wait for the windowed app to exit
            running = await operations.list();
        }
        if (running.length === 0) return;
    }

    for (const { pid } of running) operations.signalProcess(pid, 'SIGTERM');
    for (let attempt = 0; attempt < SIGNAL_ATTEMPTS; attempt++) {
        // eslint-disable-next-line no-await-in-loop -- bounded wait for the signalled processes to exit
        await operations.wait(QUIT_POLL_INTERVAL_MS);
        // eslint-disable-next-line no-await-in-loop -- bounded wait for the signalled processes to exit
        running = await operations.list();
        if (running.length === 0) return;
    }
    throw new Error(
        `Caxri is still running (PIDs ${running.map(({ pid }) => pid).join(', ')}). Stop it manually and re-run the installer.`,
    );
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
