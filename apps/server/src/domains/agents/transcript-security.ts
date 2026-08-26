import type { Stats } from 'node:fs';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';

export interface AgentTranscriptLocation {
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

function isDirectChild(root: string, path: string): boolean {
    const child = relative(root, path);
    return child !== '' && child === basename(child);
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
): Promise<SafeAgentTranscriptPath | undefined> {
    const rawBaseRoot = resolve(location.baseRoot);
    const rawRoot = resolve(location.root);
    const rawPath = resolve(location.path);
    if (!isDirectChild(rawBaseRoot, rawRoot) || !isDirectChild(rawRoot, rawPath)) return;

    let baseRoot: string;
    try {
        const baseLink = await lstat(rawBaseRoot);
        if (baseLink.isSymbolicLink() || !baseLink.isDirectory()) return;
        baseRoot = await realpath(rawBaseRoot);
    } catch (error) {
        if (!isMissing(error)) return;
        return { exists: false, path: rawPath, root: rawRoot };
    }

    let root: string;
    try {
        const rootLink = await lstat(rawRoot);
        if (rootLink.isSymbolicLink() || !rootLink.isDirectory()) return;
        root = await realpath(rawRoot);
        if (!isDirectChild(baseRoot, root)) return;
    } catch (error) {
        if (!isMissing(error)) return;
        root = resolve(baseRoot, basename(rawRoot));
        return { exists: false, path: resolve(root, basename(rawPath)), root };
    }

    try {
        const link = await lstat(rawPath);
        if (link.isSymbolicLink() || !link.isFile() || link.nlink > 1) return;
        const path = await realpath(rawPath);
        if (!isDirectChild(root, path)) return;
        return { exists: true, path, root };
    } catch (error) {
        if (!isMissing(error)) return;
        return { exists: false, path: resolve(root, basename(rawPath)), root };
    }
}

/**
 * Opens only a single-link transcript and then revalidates the full base/root/file chain. This closes parent swaps and
 * hardlink replacement between path authorization and the actual read.
 */
export async function openSafeAgentTranscript(
    location: AgentTranscriptLocation,
): Promise<SafeOpenedAgentTranscript | undefined> {
    const safe = await resolveSafeAgentTranscriptPath(location);
    if (!safe?.exists) return;
    let handle: FileHandle;
    try {
        handle = await open(
            safe.path,
            constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        );
    } catch {
        return;
    }
    let isAccepted = false;
    try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.nlink > 1) return;
        const currentSafe = await resolveSafeAgentTranscriptPath(location);
        if (!currentSafe?.exists || currentSafe.path !== safe.path) return;
        const current = await stat(currentSafe.path);
        if (current.dev !== stats.dev || current.ino !== stats.ino || current.nlink > 1) return;
        isAccepted = true;
        return { handle, path: currentSafe.path, root: currentSafe.root, stats };
    } catch {
        return;
    } finally {
        if (!isAccepted) await handle.close();
    }
}
