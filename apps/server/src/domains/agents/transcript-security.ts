import type { Stats } from 'node:fs';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

export interface AgentTranscriptLocation {
    /**
     * Optional provider-owned ancestor for fixed-depth nested layouts such as Codex `sessions/YYYY/MM/DD`.
     */
    anchorRoot?: string;
    baseRoot: string;
    path: string;
    root: string;
}

export interface SafeAgentTranscriptPath {
    exists: boolean;
    path: string;
    root: string;
}

export interface SafeOpenedAgentTranscript {
    handle: FileHandle;
    path: string;
    root: string;
    stats: Stats;
}

/**
 * Closed classification for every way {@link resolveSafeAgentTranscriptPath} and {@link openSafeAgentTranscript} decline
 * a transcript, so a caller that reports it (`TranscriptScanOptions.onFailure`) can tell a routine capability miss from
 * a real security rejection instead of every outcome looking like the same silent `undefined`.
 *
 * - `missing`: the transcript does not exist yet (or no longer does) at an otherwise valid location: the ordinary state
 *   before an Agent has written its first line, not a failure.
 * - `symlinkRejected`: a path component that must be a real file or directory was a symlink.
 * - `hardlinkRejected`: the transcript file has more than one link (`nlink > 1`), so a sibling name could rewrite the
 *   content this read trusts.
 * - `identityMismatch`: the file changed identity (dev/ino, link count, or resolved path) between authorization and the
 *   read that followed it: a TOCTOU swap, not a missing or symlinked file.
 * - `structureRejected`: a resolved path fell outside the base/root/anchor ancestry it must nest under.
 * - `openFailed`: an `lstat`/`open`/`stat` call failed for a reason other than the file being missing.
 * - `readFailed`: the transcript opened successfully but a later read of its bytes failed.
 */
export type TranscriptScanFailureReason =
    | 'hardlinkRejected'
    | 'identityMismatch'
    | 'missing'
    | 'openFailed'
    | 'readFailed'
    | 'structureRejected'
    | 'symlinkRejected';

/**
 * Optional side channel for {@link resolveSafeAgentTranscriptPath} and {@link openSafeAgentTranscript}: reports why a
 * call declined a transcript without changing which calls decline it. Passing `undefined` (the default) reproduces the
 * exact prior behavior, so this is purely additive instrumentation.
 */
export type TranscriptScanFailureReporter = (reason: TranscriptScanFailureReason) => void;

function isDirectChild(root: string, path: string): boolean {
    const child = relative(root, path);
    return child !== '' && child === basename(child);
}

function isDescendant(root: string, path: string): boolean {
    const child = relative(root, path);
    return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Anchors a provider transcript below a non-symlinked provider base and non-symlinked per-Project root. Missing roots
 * retain a safe future path so WatchHub can degrade to polling until the provider creates them.
 */
export async function resolveSafeAgentTranscriptPath(
    location: AgentTranscriptLocation,
    report?: TranscriptScanFailureReporter,
): Promise<SafeAgentTranscriptPath | undefined> {
    const rawAnchorRoot = location.anchorRoot ? resolve(location.anchorRoot) : undefined;
    const rawBaseRoot = resolve(location.baseRoot);
    const rawRoot = resolve(location.root);
    const rawPath = resolve(location.path);
    if (!isDirectChild(rawBaseRoot, rawRoot) || !isDirectChild(rawRoot, rawPath)) {
        report?.('structureRejected');
        return;
    }

    let anchorRoot: string | undefined;
    if (rawAnchorRoot) {
        try {
            const anchorLink = await lstat(rawAnchorRoot);
            if (anchorLink.isSymbolicLink()) {
                report?.('symlinkRejected');
                return;
            }
            if (!anchorLink.isDirectory()) {
                report?.('structureRejected');
                return;
            }
            anchorRoot = await realpath(rawAnchorRoot);
        } catch {
            report?.('openFailed');
            return;
        }
    }

    let baseRoot: string;
    try {
        const baseLink = await lstat(rawBaseRoot);
        if (baseLink.isSymbolicLink()) {
            report?.('symlinkRejected');
            return;
        }
        if (!baseLink.isDirectory()) {
            report?.('structureRejected');
            return;
        }
        baseRoot = await realpath(rawBaseRoot);
        if (anchorRoot && !isDescendant(anchorRoot, baseRoot)) {
            report?.('structureRejected');
            return;
        }
    } catch (error) {
        if (!isMissing(error)) {
            report?.('openFailed');
            return;
        }
        report?.('missing');
        return { exists: false, path: rawPath, root: rawRoot };
    }

    let root: string;
    try {
        const rootLink = await lstat(rawRoot);
        if (rootLink.isSymbolicLink()) {
            report?.('symlinkRejected');
            return;
        }
        if (!rootLink.isDirectory()) {
            report?.('structureRejected');
            return;
        }
        root = await realpath(rawRoot);
        if (!isDirectChild(baseRoot, root)) {
            report?.('structureRejected');
            return;
        }
    } catch (error) {
        if (!isMissing(error)) {
            report?.('openFailed');
            return;
        }
        root = resolve(baseRoot, basename(rawRoot));
        report?.('missing');
        return { exists: false, path: resolve(root, basename(rawPath)), root };
    }

    try {
        const link = await lstat(rawPath);
        if (link.isSymbolicLink()) {
            report?.('symlinkRejected');
            return;
        }
        if (!link.isFile()) {
            report?.('structureRejected');
            return;
        }
        if (link.nlink > 1) {
            report?.('hardlinkRejected');
            return;
        }
        const path = await realpath(rawPath);
        if (!isDirectChild(root, path)) {
            report?.('structureRejected');
            return;
        }
        return { exists: true, path, root };
    } catch (error) {
        if (!isMissing(error)) {
            report?.('openFailed');
            return;
        }
        report?.('missing');
        return { exists: false, path: resolve(root, basename(rawPath)), root };
    }
}

/**
 * Opens only a single-link transcript and then revalidates the full base/root/file chain. This closes parent swaps and
 * hardlink replacement between path authorization and the actual read.
 */
export async function openSafeAgentTranscript(
    location: AgentTranscriptLocation,
    report?: TranscriptScanFailureReporter,
): Promise<SafeOpenedAgentTranscript | undefined> {
    // `report` is not forwarded into this call: it already reports the specific reason (missing, symlink, structure,
    // …) for its own rejection, and forwarding it here too would double-report the same failure.
    const safe = await resolveSafeAgentTranscriptPath(location, report);
    if (!safe?.exists) return;
    let handle: FileHandle;
    try {
        handle = await open(
            safe.path,
            constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        );
    } catch {
        report?.('openFailed');
        return;
    }
    let isAccepted = false;
    try {
        const stats = await handle.stat();
        if (!stats.isFile()) {
            report?.('structureRejected');
            return;
        }
        if (stats.nlink > 1) {
            report?.('hardlinkRejected');
            return;
        }
        // A second, unreported resolution: authorization and the open above must revalidate against the exact same
        // chain, but its own rejection reason would just repeat this TOCTOU check's `identityMismatch` below.
        const currentSafe = await resolveSafeAgentTranscriptPath(location);
        if (!currentSafe?.exists || currentSafe.path !== safe.path) {
            report?.('identityMismatch');
            return;
        }
        const current = await stat(currentSafe.path);
        if (current.dev !== stats.dev || current.ino !== stats.ino || current.nlink > 1) {
            report?.('identityMismatch');
            return;
        }
        isAccepted = true;
        return { handle, path: currentSafe.path, root: currentSafe.root, stats };
    } catch {
        report?.('openFailed');
        return;
    } finally {
        if (!isAccepted) await handle.close();
    }
}
