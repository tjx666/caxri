#!/usr/bin/env bun

/**
 * Install or upgrade the released Caxri app into /Applications without tripping Gatekeeper.
 *
 * The published DMG is unsigned and unnotarized, so a browser download gets a `com.apple.quarantine` flag and macOS
 * reports the app as "damaged". Terminal downloads through `curl` never receive that flag, so this installer downloads
 * the requested release (latest by default) with resumable retries, verifies its size and SHA-256 checksum, mounts the
 * DMG, replaces /Applications/Caxri.app, and defensively strips any quarantine attribute afterwards.
 *
 * Usage: `bun run install:caxri [-- --tag v0.0.7 --no-sourcemap --skip-checksum --detach]`
 *
 * `--detach` hands the install to launchd and returns at once; use it whenever the caller runs inside the installed
 * Caxri, such as an Agent Session, because quitting Caxri ends that caller and the install with it.
 */

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { valid as validSemver } from 'semver';

import { execFileAsync } from './exec';
import { DETACHED_INSTALL_LOG, reopenCaxri, startDetachedInstall } from './install-caxri-detach';

const REPOSITORY = 'tjx666/caxri';
const INSTALL_PATH = '/Applications/Caxri.app';
const BUNDLED_CLI_PATH = join(INSTALL_PATH, 'Contents', 'Resources', 'bin', 'caxri');

interface InstallOptions {
    /**
     * Installs a DMG whose Release carries no `.sha256` companion. Off by default: the checksum is the only integrity
     * check on this unsigned distribution path, so its absence aborts the install instead of being skipped silently.
     */
    skipChecksum?: boolean;
    shouldOmitSourceMaps?: boolean;
    /**
     * Hands the install to a one-shot launchd job instead of running it in this process.
     */
    shouldDetach?: boolean;
    /**
     * Reopens Caxri afterwards, installed or not; set on the detached run, which has no user to reopen it.
     */
    shouldRelaunch?: boolean;
    tag?: string;
}

const USAGE = 'Usage: install-caxri [--tag vX.Y.Z] [--no-sourcemap] [--skip-checksum] [--detach]';

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
        if (argument === '--skip-checksum') {
            options.skipChecksum = true;
            continue;
        }
        if (argument === '--no-sourcemap') {
            options.shouldOmitSourceMaps = true;
            continue;
        }
        if (argument === '--detach') {
            options.shouldDetach = true;
            continue;
        }
        if (argument === '--relaunch') {
            options.shouldRelaunch = true;
            continue;
        }
        throw new Error(`Unknown argument: ${argument}. ${USAGE}`);
    }
    return options;
}

/**
 * Converts the canonical GitHub Release tag into the version embedded in Caxri artifacts.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/install-caxri.test.ts
export function releaseVersionFromTag(tag: string): string {
    const version = tag.startsWith('v') ? tag.slice(1) : '';
    if (!/^\d/u.test(version) || version.trim() !== version || validSemver(version) === null) {
        throw new Error(
            `Expected a canonical vX.Y.Z Release tag, received ${JSON.stringify(tag)}.`,
        );
    }
    return version;
}

function releaseDmgName(tag: string, shouldOmitSourceMaps: boolean): string {
    const suffix = shouldOmitSourceMaps ? '-arm64-nosourcemap.dmg' : '-arm64.dmg';
    return `Caxri-${releaseVersionFromTag(tag)}${suffix}`;
}

/**
 * Picks the exact versioned DMG artifact and its checksum companion out of a downloaded Release directory.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/install-caxri.test.ts
export function findDmgPair(
    names: string[],
    releaseTag: string,
    shouldOmitSourceMaps = false,
): { checksum?: string; dmg: string } {
    const expected = releaseDmgName(releaseTag, shouldOmitSourceMaps);
    const candidates = names.filter((name) => name === expected);
    if (candidates.length !== 1) {
        throw new Error(
            `Expected exactly one ${expected} asset for ${releaseTag}, found ${candidates.length}.`,
        );
    }
    const dmg = candidates.at(0);
    if (!dmg) throw new Error('The selected Apple Silicon DMG disappeared unexpectedly.');
    const checksum = names.find((name) => name === `${dmg}.sha256`);
    return { checksum, dmg };
}

/**
 * Prevents a correctly named Release asset from replacing the installed app with a differently versioned bundle.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/install-caxri.test.ts
export function assertReleaseBundleVersion(releaseTag: string, bundleVersion: string): string {
    const expected = releaseVersionFromTag(releaseTag);
    const actual = bundleVersion.trim();
    if (actual !== expected) {
        throw new Error(
            `${releaseTag} must contain Caxri ${expected}, but the downloaded bundle reports ${actual || 'an empty version'}.`,
        );
    }
    return actual;
}

type ChecksumStep = { checksum: string; kind: 'verify' } | { kind: 'skip'; warning: string };

/**
 * Decides what happens between download and mount. A Release without its `.sha256` used to fall through to `hdiutil
 * attach` with no message at all, so an upload that failed halfway, a deleted asset, or a swapped DMG installed like a
 * verified one. Missing evidence now stops the install unless the user explicitly opted out.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/install-caxri.test.ts
export function resolveChecksumStep(
    pair: { checksum?: string; dmg: string },
    options: Pick<InstallOptions, 'skipChecksum' | 'tag'>,
): ChecksumStep {
    if (pair.checksum) return { checksum: pair.checksum, kind: 'verify' };
    const release = options.tag ?? 'the latest release';
    if (options.skipChecksum) {
        return {
            kind: 'skip',
            warning: `WARNING: ${release} provides no ${pair.dmg}.sha256; installing ${pair.dmg} without verifying its integrity because --skip-checksum was given.`,
        };
    }
    throw new Error(
        `${release} provides no ${pair.dmg}.sha256, so the downloaded DMG cannot be verified; installation aborted. Re-run with --skip-checksum to install it anyway.`,
    );
}

const BUNDLE_CONTENTS_PREFIX = `${INSTALL_PATH}/Contents/`;
const QUIT_POLL_INTERVAL_MS = 500;
const SIGNAL_ATTEMPTS = 10;
const HOST_STOP_TIMEOUT_MS = 30_000;

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
    stopHost: (profilePath: string) => Promise<number | undefined>;
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

/**
 * Restricts destructive shutdown to executables loaded from the exact installed application bundle.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/install-caxri.test.ts
export function isInstalledCaxriCommand(command: string): boolean {
    return command.startsWith(BUNDLE_CONTENTS_PREFIX);
}

/**
 * Resolves the profile owned by the installed Desktop. Electron helper argv is authoritative for explicit profiles; the
 * fallback mirrors Electron's current packaged default derived from the `@caxri/desktop` package name.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/install-caxri.test.ts
export function resolveInstalledProfilePath(
    processes: ReadonlyArray<Pick<CaxriProcess, 'command'>>,
    environmentPath = process.env.CAXRI_USER_DATA_DIR,
    homeDirectory = homedir(),
): string {
    if (environmentPath && isAbsolute(environmentPath)) return environmentPath;
    for (const { command } of processes) {
        const marker = '--user-data-dir=';
        const markerIndex = command.indexOf(marker);
        if (markerIndex === -1) continue;
        const remainder = command.slice(markerIndex + marker.length);
        const nextFlagIndex = remainder.indexOf(' --');
        const profilePath = (
            nextFlagIndex === -1 ? remainder : remainder.slice(0, nextFlagIndex)
        ).trim();
        if (profilePath && isAbsolute(profilePath)) return profilePath;
    }
    return join(homeDirectory, 'Library', 'Application Support', '@caxri', 'desktop');
}

/**
 * Defines the exact installed CLI invocation used before replacing its application bundle.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/install-caxri.test.ts
export function hostStopCommand(profilePath: string): { arguments: string[]; command: string } {
    return {
        command: BUNDLED_CLI_PATH,
        arguments: [
            'host',
            'stop',
            '--force',
            '--profile',
            profilePath,
            '--yes',
            '--json',
            '--timeout',
            String(HOST_STOP_TIMEOUT_MS),
        ],
    };
}

// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/install-caxri.test.ts
export function parseHostStopActivePtyCount(stdout: string): number | undefined {
    try {
        const value: unknown = JSON.parse(stdout);
        const activePtyCount: unknown =
            typeof value === 'object' && value !== null
                ? Reflect.get(value, 'activePtyCount')
                : undefined;
        return Number.isSafeInteger(activePtyCount) && Number(activePtyCount) >= 0
            ? Number(activePtyCount)
            : undefined;
    } catch {
        return undefined;
    }
}

async function listInstalledCaxriProcesses(): Promise<CaxriProcess[]> {
    const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,command=']);
    return stdout.split('\n').flatMap((line) => {
        const match = /^\s*(?<pid>\d+)\s+(?<command>\S.*)$/u.exec(line);
        const groups = match?.groups;
        if (!groups) return [];
        const command = groups.command;
        if (!command || !isInstalledCaxriCommand(command)) return [];
        return [{ command, pid: Number(groups.pid) }];
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
    stopHost: async (profilePath) => {
        const invocation = hostStopCommand(profilePath);
        const { stdout } = await execFileAsync(invocation.command, invocation.arguments, {
            timeout: HOST_STOP_TIMEOUT_MS + 5_000,
        });
        return parseHostStopActivePtyCount(stdout);
    },
    wait: (milliseconds) => sleep(milliseconds),
};

/**
 * Stops everything running out of the installed bundle before it is replaced; `ditto` over a live app corrupts both the
 * bundle and the running process.
 *
 * The installed, version-matched CLI stops the Host first. When it reports active tasks (or cannot report a result),
 * the installer then force-terminates the Desktop and its helpers so automatic reconnect cannot restart that Host and
 * the ordinary quit confirmation cannot block an unattended install. With no active tasks, Desktop gets its normal quit
 * path so it can persist window state. All remaining exact bundle-owned processes fall back from SIGTERM to SIGKILL.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/install-caxri.test.ts
export async function quitRunningCaxri(
    operations: QuitOperations = defaultQuitOperations,
): Promise<void> {
    let running = await operations.list();
    if (running.length === 0) return;
    console.log('Quitting the running Caxri…');

    let shouldForceDesktop = false;
    if (running.some(({ command }) => isHeadlessCaxriProcess(command))) {
        try {
            const activePtyCount = await operations.stopHost(resolveInstalledProfilePath(running));
            shouldForceDesktop = activePtyCount !== 0;
        } catch {
            shouldForceDesktop = true;
            console.warn('Bundled CLI Host stop failed; using exact-process shutdown fallback.');
        }
        running = await operations.list();
    }

    if (running.some(({ command }) => !isHeadlessCaxriProcess(command))) {
        if (shouldForceDesktop) {
            for (const { command, pid } of running) {
                if (!isHeadlessCaxriProcess(command)) operations.signalProcess(pid, 'SIGKILL');
            }
        } else {
            try {
                await operations.quitApplication();
            } catch {
                console.warn(
                    'Caxri did not accept the normal quit request; using exact-process shutdown fallback.',
                );
            }
        }
        for (let attempt = 0; attempt < SIGNAL_ATTEMPTS; attempt++) {
            // eslint-disable-next-line no-await-in-loop -- bounded wait for Desktop-owned processes to exit
            await operations.wait(QUIT_POLL_INTERVAL_MS);
            // eslint-disable-next-line no-await-in-loop -- bounded wait for Desktop-owned processes to exit
            running = await operations.list();
            if (running.every(({ command }) => isHeadlessCaxriProcess(command))) break;
        }
    }
    if (running.length === 0) return;

    for (const { pid } of running) operations.signalProcess(pid, 'SIGTERM');
    for (let attempt = 0; attempt < SIGNAL_ATTEMPTS; attempt++) {
        // eslint-disable-next-line no-await-in-loop -- bounded wait for the signalled processes to exit
        await operations.wait(QUIT_POLL_INTERVAL_MS);
        // eslint-disable-next-line no-await-in-loop -- bounded wait for the signalled processes to exit
        running = await operations.list();
        if (running.length === 0) return;
    }
    for (const { pid } of running) operations.signalProcess(pid, 'SIGKILL');
    for (let attempt = 0; attempt < SIGNAL_ATTEMPTS; attempt++) {
        // eslint-disable-next-line no-await-in-loop -- bounded wait for force-terminated processes to exit
        await operations.wait(QUIT_POLL_INTERVAL_MS);
        // eslint-disable-next-line no-await-in-loop -- bounded wait for force-terminated processes to exit
        running = await operations.list();
        if (running.length === 0) return;
    }
    throw new Error(
        `Caxri is still running after forced shutdown (PIDs ${running.map(({ pid }) => pid).join(', ')}); installation was aborted.`,
    );
}

const DOWNLOAD_ATTEMPTS = 5;
const DOWNLOAD_RETRY_DELAY_MS = 3000;
const DOWNLOAD_ATTEMPT_TIMEOUT_MS = 600_000;

interface ReleaseAsset {
    name: string;
    size: number;
    url: string;
}

/**
 * Reads `gh release view --json tagName,assets` output into the Release tag and the assets this installer may fetch.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/install-caxri.test.ts
export function parseReleaseView(stdout: string): { assets: ReleaseAsset[]; tag: string } {
    const parsed = JSON.parse(stdout) as {
        assets?: Array<{ name?: unknown; size?: unknown; url?: unknown }>;
        tagName?: unknown;
    };
    if (typeof parsed.tagName !== 'string') throw new Error('gh release view returned no tagName.');
    const assets = (parsed.assets ?? []).flatMap((asset) =>
        typeof asset.name === 'string' &&
        typeof asset.size === 'number' &&
        typeof asset.url === 'string'
            ? [{ name: asset.name, size: asset.size, url: asset.url }]
            : [],
    );
    return { assets, tag: parsed.tagName };
}

/**
 * `curl` arguments that resume into an existing partial file. A slow proxy can cut a 250 MB DMG transfer halfway (`gh
 * release download` then fails with `unexpected EOF` and keeps nothing), so every attempt continues from the bytes
 * already on disk, and a transfer that stalls below 1 KiB/s for a minute is aborted so the next attempt can resume it.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/install-caxri.test.ts
export function resumableDownloadArguments(url: string, destination: string): string[] {
    return [
        '--fail',
        '--location',
        '--silent',
        '--show-error',
        '--continue-at',
        '-',
        '--speed-limit',
        '1024',
        '--speed-time',
        '60',
        '--output',
        destination,
        url,
    ];
}

interface DownloadRetryOperations {
    download: () => Promise<void>;
    onRetry: (failedAttempt: number, error: unknown) => void;
    wait: (milliseconds: number) => Promise<void>;
}

/**
 * Runs a resumable download up to `attempts` times, rethrowing the last failure once the attempts are spent.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/install-caxri.test.ts
export async function downloadWithRetries(
    operations: DownloadRetryOperations,
    attempts = DOWNLOAD_ATTEMPTS,
): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            // eslint-disable-next-line no-await-in-loop -- each attempt resumes the bytes the previous one left
            await operations.download();
            return;
        } catch (error) {
            if (attempt >= attempts) throw error;
            operations.onRetry(attempt, error);
            // eslint-disable-next-line no-await-in-loop -- backoff between resumed attempts
            await operations.wait(DOWNLOAD_RETRY_DELAY_MS);
        }
    }
}

/**
 * Rejects a download whose byte count differs from the Release's record before the checksum or mount step reads it.
 */
// eslint-disable-next-line unicorn/no-exports-in-scripts -- imported by scripts/__tests__/install-caxri.test.ts
export function assertDownloadedSize(
    asset: Pick<ReleaseAsset, 'name' | 'size'>,
    actual: number,
): void {
    if (actual !== asset.size) {
        throw new Error(
            `${asset.name} downloaded ${actual} bytes, but the Release records ${asset.size}; installation aborted.`,
        );
    }
}

async function downloadReleaseAsset(asset: ReleaseAsset, directory: string): Promise<void> {
    const destination = join(directory, asset.name);
    await downloadWithRetries({
        download: async () => {
            await execFileAsync('curl', resumableDownloadArguments(asset.url, destination), {
                timeout: DOWNLOAD_ATTEMPT_TIMEOUT_MS,
            });
        },
        onRetry: (failedAttempt, error) => {
            const reason = error instanceof Error ? error.message.trim() : String(error);
            console.warn(
                `Download of ${asset.name} was interrupted (attempt ${failedAttempt}/${DOWNLOAD_ATTEMPTS}): ${reason}. Resuming…`,
            );
        },
        wait: (milliseconds) => sleep(milliseconds),
    });
    assertDownloadedSize(asset, (await stat(destination)).size);
}

async function main(): Promise<void> {
    if (process.platform !== 'darwin') throw new Error('The Caxri installer is macOS-only.');
    const argv = process.argv.slice(2);
    const options = parseArguments(argv);
    if (options.shouldDetach) {
        const label = await startDetachedInstall(
            join(import.meta.dirname, '..'),
            argv.filter((argument) => argument !== '--detach'),
        );
        console.log(
            `Started detached install job ${label}; Caxri will quit and reopen. Log: ${DETACHED_INSTALL_LOG}`,
        );
        return;
    }

    const downloadDirectory = await mkdtemp(join(tmpdir(), 'caxri-install-'));
    let mountPoint: string | undefined;
    try {
        const releaseViewArguments = [
            'release',
            'view',
            ...(options.tag ? [options.tag] : []),
            '--repo',
            REPOSITORY,
            '--json',
            'tagName,assets',
        ];
        const { stdout: releaseViewOutput } = await execFileAsync('gh', releaseViewArguments, {
            timeout: 60_000,
        });
        const release = parseReleaseView(releaseViewOutput);
        const releaseTag = release.tag;
        const pair = findDmgPair(
            release.assets.map(({ name }) => name),
            releaseTag,
            options.shouldOmitSourceMaps,
        );
        const checksumStep = resolveChecksumStep(pair, { ...options, tag: releaseTag });
        console.log(`Downloading ${releaseTag} from ${REPOSITORY}…`);
        await Promise.all(
            [pair.dmg, ...(pair.checksum ? [pair.checksum] : [])].map((name) => {
                const asset = release.assets.find((candidate) => candidate.name === name);
                if (!asset) throw new Error(`The ${name} asset disappeared from ${releaseTag}.`);
                return downloadReleaseAsset(asset, downloadDirectory);
            }),
        );

        if (checksumStep.kind === 'verify') {
            await execFileAsync('shasum', ['-a', '256', '-c', checksumStep.checksum], {
                cwd: downloadDirectory,
            });
            console.log('Checksum verified.');
        } else {
            console.warn(checksumStep.warning);
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

        const { stdout: mountedVersion } = await execFileAsync('defaults', [
            'read',
            `${join(mountPoint, 'Caxri.app')}/Contents/Info`,
            'CFBundleShortVersionString',
        ]);
        assertReleaseBundleVersion(releaseTag, mountedVersion);

        await quitRunningCaxri();
        await rm(INSTALL_PATH, { force: true, recursive: true });
        await execFileAsync('ditto', [join(mountPoint, 'Caxri.app'), INSTALL_PATH]);
        try {
            // curl downloads carry no quarantine flag, but strip defensively in case the tooling changes.
            await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', INSTALL_PATH]);
        } catch {
            // A missing attribute is the expected case; installation already succeeded.
        }

        const { stdout: version } = await execFileAsync('defaults', [
            'read',
            `${INSTALL_PATH}/Contents/Info`,
            'CFBundleShortVersionString',
        ]);
        console.log(
            `Installed Caxri ${assertReleaseBundleVersion(releaseTag, version)} at ${INSTALL_PATH}.`,
        );
    } finally {
        try {
            if (mountPoint) await execFileAsync('hdiutil', ['detach', mountPoint]);
        } catch {
            // Best-effort unmount; the temporary mount disappears on reboot at worst.
        }
        await rm(downloadDirectory, { force: true, recursive: true });
        if (options.shouldRelaunch) await reopenCaxri(INSTALL_PATH);
    }
}

if (import.meta.main) {
    await main();
}
