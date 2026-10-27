import type { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { launchLocationKind } from './move-to-apps';

/**
 * Why this install cannot replace its own bundle. Closed so a log can count each cause; every value falls back to the
 * manual "open the DMG" install instead of failing the update.
 */
type InPlaceInstallUnavailableReason =
    'not-writable' | 'platform' | 'transient-location' | 'unpackaged';

export type InPlaceInstallTarget =
    | { bundlePath: string; kind: 'available' }
    | { kind: 'unavailable'; reason: InPlaceInstallUnavailableReason };

/**
 * The `.app` directory around a macOS executable (`…/Caxri.app/Contents/MacOS/Caxri`), or `undefined` when the path
 * does not have that shape.
 */
export function appBundlePath(executablePath: string): string | undefined {
    const macOsDirectory = dirname(executablePath);
    const contentsDirectory = dirname(macOsDirectory);
    const bundle = dirname(contentsDirectory);
    return basename(macOsDirectory) === 'MacOS' &&
        basename(contentsDirectory) === 'Contents' &&
        bundle.endsWith('.app')
        ? bundle
        : undefined;
}

/**
 * Decides whether Caxri can replace its own bundle. Electron's `autoUpdater` (Squirrel.Mac) is not an option because it
 * insists on a Developer ID signature these builds do not have, so Caxri swaps the bundle directory itself. That needs
 * a packaged macOS app whose bundle and parent folder the user can write. A run from a mounted DMG or from App
 * Translocation's read-only copy cannot be replaced; those are the cases `offerMoveToApps` exists for.
 */
export async function resolveInPlaceInstallTarget(input: {
    executablePath: string;
    isPackaged: boolean;
    platform: NodeJS.Platform;
}): Promise<InPlaceInstallTarget> {
    if (!input.isPackaged) return { kind: 'unavailable', reason: 'unpackaged' };
    if (input.platform !== 'darwin') return { kind: 'unavailable', reason: 'platform' };
    const bundlePath = appBundlePath(input.executablePath);
    if (!bundlePath) return { kind: 'unavailable', reason: 'platform' };
    const location = launchLocationKind(input.executablePath);
    if (location === 'dmg' || location === 'translocated')
        return { kind: 'unavailable', reason: 'transient-location' };
    try {
        // Renaming the bundle needs write access to its parent; rewriting it needs access to the bundle itself.
        await access(dirname(bundlePath), constants.W_OK);
        await access(bundlePath, constants.W_OK);
    } catch {
        return { kind: 'unavailable', reason: 'not-writable' };
    }
    return { kind: 'available', bundlePath };
}

/**
 * Runs one command with structured argv and resolves its stdout; rejects on a non-zero exit.
 */
type InstallCommandRunner = (file: string, arguments_: readonly string[]) => Promise<string>;

const runInstallCommand: InstallCommandRunner = (file, arguments_) =>
    new Promise((resolve, reject) => {
        const child = spawn(file, arguments_, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve(stdout);
            else reject(new Error(`${basename(file)} exited with ${code}: ${stderr.trim()}`));
        });
    });

async function readPlistString(
    run: InstallCommandRunner,
    bundlePath: string,
    key: string,
): Promise<string> {
    const output = await run('/usr/libexec/PlistBuddy', [
        '-c',
        `Print :${key}`,
        join(bundlePath, 'Contents', 'Info.plist'),
    ]);
    return output.trim();
}

/**
 * Cleanup that must not mask the error that triggered it: a mount or folder left behind only costs disk space.
 */
async function detachQuietly(run: InstallCommandRunner, mountPoint: string): Promise<void> {
    try {
        await run('/usr/bin/hdiutil', ['detach', mountPoint, '-force']);
    } catch {
        // Already detached or busy; macOS reclaims the mount on its own.
    }
}

async function removeQuietly(path: string): Promise<void> {
    try {
        await rm(path, { recursive: true, force: true });
    } catch {
        // Best effort, see detachQuietly.
    }
}

export interface StageUpdateBundleInput {
    /**
     * The installed bundle, whose name and bundle identifier the staged copy must keep.
     */
    bundlePath: string;
    dmgPath: string;
    run?: InstallCommandRunner;
    /**
     * Receives exactly one `<name>.app`; emptied first so a previous release's copy never survives.
     */
    stagingDirectory: string;
    version: string;
}

/**
 * Unpacks the verified DMG into `stagingDirectory` ahead of time, so the restart itself is only two renames. The copy
 * must carry the expected version and the installed app's bundle identifier, and its main executable must be in place.
 *
 * Integrity comes from the DMG's SHA-256 check before this runs, not from `codesign --verify`: the release bundles are
 * only linker-signed with no sealed resources, so even the installed app fails `--strict` verification and a signature
 * check cannot tell a complete copy from a truncated one.
 */
export async function stageUpdateBundle(input: StageUpdateBundleInput): Promise<string> {
    const run = input.run ?? runInstallCommand;
    const stagedPath = join(input.stagingDirectory, basename(input.bundlePath));
    await rm(input.stagingDirectory, { recursive: true, force: true });
    await mkdir(input.stagingDirectory, { recursive: true, mode: 0o700 });
    const mountPoint = await mkdtemp(join(tmpdir(), 'caxri-update-'));
    try {
        await run('/usr/bin/hdiutil', [
            'attach',
            '-nobrowse',
            '-readonly',
            '-noautoopen',
            '-mountpoint',
            mountPoint,
            input.dmgPath,
        ]);
        try {
            const apps = (await readdir(mountPoint)).filter((name) => name.endsWith('.app'));
            if (apps.length !== 1)
                throw new Error(`The update disk image holds ${apps.length} apps instead of one.`);
            await run('/usr/bin/ditto', [join(mountPoint, apps[0]), stagedPath]);
        } finally {
            await detachQuietly(run, mountPoint);
        }
    } finally {
        await removeQuietly(mountPoint);
    }
    const [stagedVersion, stagedIdentifier, installedIdentifier, executable] = await Promise.all([
        readPlistString(run, stagedPath, 'CFBundleShortVersionString'),
        readPlistString(run, stagedPath, 'CFBundleIdentifier'),
        readPlistString(run, input.bundlePath, 'CFBundleIdentifier'),
        readPlistString(run, stagedPath, 'CFBundleExecutable'),
    ]);
    if (stagedVersion !== input.version)
        throw new Error(`The unpacked update is version ${stagedVersion}, not ${input.version}.`);
    if (stagedIdentifier !== installedIdentifier)
        throw new Error('The unpacked update is a different app than the installed one.');
    await access(join(stagedPath, 'Contents', 'MacOS', executable), constants.X_OK);
    return stagedPath;
}

/**
 * The Info.plist key carrying the database baseline a build starts from (`BASELINE_SCHEMA_VERSION`). A database older
 * than an update's baseline is rebuilt empty on its first launch, which is why the updater compares the two bundles.
 */
const SCHEMA_BASELINE_PLIST_KEY = 'CaxriSchemaBaseline';

async function readSchemaBaseline(
    run: InstallCommandRunner,
    bundlePath: string,
): Promise<number | undefined> {
    try {
        const value = Number(await readPlistString(run, bundlePath, SCHEMA_BASELINE_PLIST_KEY));
        return Number.isSafeInteger(value) && value > 0 ? value : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Why installing the staged bundle clears the Project and Session list, or `undefined` when it does not. Only
 * `baseline-bumped` is a real database baseline upgrade; the unreadable reasons are the fail-safe that keeps a damaged
 * or unexpected bundle from installing silently, named apart so the install log can tell them from a real reset.
 */
export type StagedUpdateResetReason =
    'baseline-bumped' | 'installed-unreadable' | 'staged-unreadable';

/**
 * Whether installing the staged bundle clears the Project and Session list: its database baseline is newer than the
 * installed one's. A baseline that cannot be read on either side counts as a reset, so a damaged or unexpected bundle
 * never installs silently.
 */
export async function stagedUpdateResetReason(input: {
    bundlePath: string;
    run?: InstallCommandRunner;
    stagedPath: string;
}): Promise<StagedUpdateResetReason | undefined> {
    const run = input.run ?? runInstallCommand;
    const [staged, installed] = await Promise.all([
        readSchemaBaseline(run, input.stagedPath),
        readSchemaBaseline(run, input.bundlePath),
    ]);
    if (staged === undefined) return 'staged-unreadable';
    if (installed === undefined) return 'installed-unreadable';
    return staged > installed ? 'baseline-bumped' : undefined;
}

/**
 * Closed outcomes the installer script records; `missing` is a pending install whose script never wrote a result.
 */
type InPlaceInstallOutcome =
    'installed' | 'missing' | 'move-in-failed' | 'move-out-failed' | 'timeout';

/**
 * Waits for Main to exit, moves the installed bundle aside, moves the staged bundle into its place, and restores the
 * old one if the second rename fails. It must run outside the app because a bundle cannot be swapped while its own
 * process is still running from it. Arguments arrive as positional parameters, never interpolated into the script.
 *
 * `mv` is a rename when both paths share a volume (the profile and `/Applications` normally do) and falls back to a
 * copy otherwise; a copy that fails midway leaves a partial target, which the rollback removes before restoring. The
 * old bundle is kept in the profile until the next launch confirms the new version started.
 */
export const IN_PLACE_INSTALL_SCRIPT = String.raw`
pid="$1"; target="$2"; staged="$3"; backup="$4"; result="$5"; relaunch="$6"
record() { printf '%s\n' "$1" > "$result.tmp" && mv -f "$result.tmp" "$result"; }
reopen() { if [ "$relaunch" = 1 ]; then /usr/bin/open "$target"; fi; }
waited=0
while kill -0 "$pid" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 600 ]; then record timeout; reopen; exit 1; fi
  sleep 0.1
done
rm -rf "$backup"
mkdir -p "$(dirname "$backup")"
if ! mv "$target" "$backup"; then record move-out-failed; reopen; exit 1; fi
if ! mv "$staged" "$target"; then
  rm -rf "$target"
  mv "$backup" "$target"
  record move-in-failed
  reopen
  exit 1
fi
record installed
reopen
`;

interface InPlaceInstallPaths {
    /**
     * Where the replaced bundle waits until the next launch confirms the new one.
     */
    backupPath: string;
    pendingPath: string;
    resultPath: string;
}

export function inPlaceInstallPaths(updatesDirectory: string, bundleName: string) {
    return {
        backupPath: join(updatesDirectory, 'previous', bundleName),
        pendingPath: join(updatesDirectory, 'install-pending.json'),
        resultPath: join(updatesDirectory, 'install-result'),
    } satisfies InPlaceInstallPaths;
}

export interface LaunchInPlaceInstallInput {
    bundlePath: string;
    fromVersion: string;
    /**
     * The process the script waits for; Main's own PID.
     */
    pid: number;
    relaunch: boolean;
    spawnDetached?: (file: string, arguments_: readonly string[]) => void;
    stagedPath: string;
    toVersion: string;
    updatesDirectory: string;
}

function spawnDetachedScript(file: string, arguments_: readonly string[]): void {
    spawn(file, arguments_, { detached: true, stdio: 'ignore' }).unref();
}

/**
 * Records the pending install, then starts the detached installer script. The script outlives Main: Main exits right
 * after this returns, which is the moment the script is waiting for.
 */
export async function launchInPlaceInstall(input: LaunchInPlaceInstallInput): Promise<void> {
    const paths = inPlaceInstallPaths(input.updatesDirectory, basename(input.bundlePath));
    await rm(paths.resultPath, { force: true });
    await writeFile(
        paths.pendingPath,
        JSON.stringify({ from: input.fromVersion, to: input.toVersion }),
        { mode: 0o600 },
    );
    (input.spawnDetached ?? spawnDetachedScript)('/bin/sh', [
        '-c',
        IN_PLACE_INSTALL_SCRIPT,
        'caxri-update-install',
        String(input.pid),
        input.bundlePath,
        input.stagedPath,
        paths.backupPath,
        paths.resultPath,
        input.relaunch ? '1' : '0',
    ]);
}

export interface InPlaceInstallReport {
    from: string;
    outcome: InPlaceInstallOutcome;
    to: string;
}

const OUTCOMES = new Set<InPlaceInstallOutcome>([
    'installed',
    'move-in-failed',
    'move-out-failed',
    'timeout',
]);

/**
 * Reads what the previous run's installer did, then clears the record and the kept-aside old bundle. Resolves
 * `undefined` when no install was pending. Best-effort throughout: a leftover file only costs disk space.
 */
export async function collectInPlaceInstallReport(
    updatesDirectory: string,
    bundleName: string,
): Promise<InPlaceInstallReport | undefined> {
    const paths = inPlaceInstallPaths(updatesDirectory, bundleName);
    let pending: { from?: unknown; to?: unknown };
    try {
        pending = JSON.parse(await readFile(paths.pendingPath, 'utf8')) as typeof pending;
    } catch {
        return undefined;
    }
    let outcome: InPlaceInstallOutcome = 'missing';
    try {
        const recorded = (await readFile(paths.resultPath, 'utf8')).trim();
        if (OUTCOMES.has(recorded as InPlaceInstallOutcome))
            outcome = recorded as InPlaceInstallOutcome;
    } catch {
        // No result: the script never ran or was killed before recording one.
    }
    await Promise.all(
        [paths.pendingPath, paths.resultPath, dirname(paths.backupPath)].map(removeQuietly),
    );
    return {
        from: typeof pending.from === 'string' ? pending.from : 'unknown',
        outcome,
        to: typeof pending.to === 'string' ? pending.to : 'unknown',
    };
}
