import type { Dirent, FSWatcher, Stats } from 'node:fs';
import { watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

import { AsyncSemaphore, mapWithConcurrency } from './concurrency';

export interface BuildFreshnessOptions {
    inputPaths: string[];
    outputPaths: string[];
    watchedDirectoryExtensions: ReadonlySet<string>;
    staleMessage: string;
}

export interface BuildFreshnessGuard {
    /**
    Runs a full recursive scan only after creation or an observed filesystem change.
     */
    assertFresh(): Promise<void>;
    /**
    Releases filesystem watchers when a long-lived test process shuts down.
     */
    dispose(): void;
    /**
    Exposes scan work for focused performance regressions without timing assertions.
     */
    readonly fullScanCount: number;
}

interface BuildFreshnessGuardDependencies {
    watch?: (
        path: string,
        options: { persistent: false; recursive: boolean },
        listener: () => void,
    ) => FSWatcher;
}

interface InputSnapshotEntry {
    freshnessInput: boolean;
    mtimeMs: number;
    path: string;
}

async function newestInputMtimeMs(
    path: string,
    watchedDirectoryExtensions: ReadonlySet<string>,
    isExplicit: boolean,
    io: AsyncSemaphore,
): Promise<number> {
    let entries: Dirent[];
    try {
        const metadata = await io.run(() => stat(path));
        if (metadata.isFile())
            return isExplicit || watchedDirectoryExtensions.has(extname(path))
                ? metadata.mtimeMs
                : 0;
        if (!metadata.isDirectory()) return 0;
        entries = await io.run(() => readdir(path, { withFileTypes: true }));
    } catch {
        return 0;
    }

    const mtimes = await mapWithConcurrency(entries, 32, async (entry) => {
        const entryPath = join(path, entry.name);
        if (entry.isDirectory())
            return newestInputMtimeMs(entryPath, watchedDirectoryExtensions, false, io);
        if (entry.isFile() && watchedDirectoryExtensions.has(extname(entry.name)))
            return (await io.run(() => stat(entryPath))).mtimeMs;
        return 0;
    });
    return Math.max(0, ...mtimes);
}

async function collectInputSnapshot(
    path: string,
    watchedDirectoryExtensions: ReadonlySet<string>,
    isExplicit: boolean,
    io: AsyncSemaphore,
): Promise<InputSnapshotEntry[]> {
    let metadata: Stats;
    try {
        metadata = await io.run(() => stat(path));
    } catch (error) {
        if (isExplicit || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return [];
    }

    if (metadata.isFile()) {
        return isExplicit || watchedDirectoryExtensions.has(extname(path))
            ? [{ freshnessInput: true, mtimeMs: metadata.mtimeMs, path }]
            : [];
    }
    if (!metadata.isDirectory()) return [];

    let entries: Dirent[];
    try {
        entries = await io.run(() => readdir(path, { withFileTypes: true }));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    const descendants = await mapWithConcurrency(entries, 32, (entry) =>
        collectInputSnapshot(join(path, entry.name), watchedDirectoryExtensions, false, io),
    );
    return [{ freshnessInput: false, mtimeMs: metadata.mtimeMs, path }, ...descendants.flat()];
}

async function outputSnapshot(paths: readonly string[]): Promise<InputSnapshotEntry[]> {
    try {
        return await Promise.all(
            paths.map(async (path) => ({
                freshnessInput: false,
                mtimeMs: (await stat(path)).mtimeMs,
                path,
            })),
        );
    } catch {
        throw new Error('missing build output');
    }
}

function areSnapshotsEqual(
    left: readonly InputSnapshotEntry[],
    right: readonly InputSnapshotEntry[],
): boolean {
    return (
        left.length === right.length &&
        left.every(
            (entry, index) =>
                entry.path === right[index]?.path && entry.mtimeMs === right[index]?.mtimeMs,
        )
    );
}

/**
 * Rejects focused E2E runs when any declared build input is newer than the oldest required output.
 * Comparing every process entry prevents a fresh Main bundle from masking a stale Runtime, preload,
 * or Renderer bundle.
 */
export async function assertBuildOutputsFresh(options: BuildFreshnessOptions): Promise<void> {
    const io = new AsyncSemaphore(32);
    let outputMtimes: number[];
    try {
        outputMtimes = await mapWithConcurrency(
            options.outputPaths,
            32,
            async (path) => (await io.run(() => stat(path))).mtimeMs,
        );
    } catch {
        throw new Error(options.staleMessage);
    }
    const oldestOutputMtimeMs = Math.min(...outputMtimes);

    const inputMtimes = await mapWithConcurrency(options.inputPaths, 32, (path) =>
        newestInputMtimeMs(path, options.watchedDirectoryExtensions, true, io),
    );
    const newestBuildInputMtimeMs = Math.max(0, ...inputMtimes);
    if (newestBuildInputMtimeMs > oldestOutputMtimeMs) throw new Error(options.staleMessage);
}

/**
 * Keeps focused Playwright launches fail-closed without walking every build input for every app
 * launch. A recursive watcher invalidates the cached success for source changes, while required
 * outputs are still statted on every launch so a deleted bundle cannot be hidden by watcher timing.
 * Direct Playwright commands start a new process and therefore always scan before their first
 * launch; within one worker, trusting the watcher avoids replacing the traversal with hundreds of
 * per-file stats. E2E specs must not rewrite repository build inputs while their worker is running.
 */
export function createBuildFreshnessGuard(
    options: BuildFreshnessOptions,
    dependencies: BuildFreshnessGuardDependencies = {},
): BuildFreshnessGuard {
    let fullScanCount = 0;
    let isInvalidated = true;
    let isWatcherFailed = false;
    let inFlight: Promise<void> | undefined;
    let inputSnapshot: InputSnapshotEntry[] = [];
    let requiredOutputSnapshot: InputSnapshotEntry[] = [];
    let watchers: FSWatcher[] = [];

    const dispose = () => {
        for (const watcher of watchers) watcher.close();
        watchers = [];
    };

    const invalidate = () => {
        isInvalidated = true;
    };

    const handleWatcherError = () => {
        isWatcherFailed = true;
        invalidate();
        dispose();
    };

    const watchPath = (path: string, isRecursive: boolean) => {
        const createWatcher =
            dependencies.watch ??
            ((watchedPath, watchOptions, listener) => watch(watchedPath, watchOptions, listener));
        const watcher = createWatcher(
            path,
            { persistent: false, recursive: isRecursive },
            invalidate,
        );
        watcher.on('error', handleWatcherError);
        watchers.push(watcher);
    };

    const beginWatching = async () => {
        isWatcherFailed = false;
        try {
            const inputMetadata = await Promise.all(options.inputPaths.map((path) => stat(path)));
            for (const [index, path] of options.inputPaths.entries()) {
                watchPath(path, inputMetadata[index].isDirectory());
            }
            const outputDirectories = new Set(options.outputPaths.map((path) => dirname(path)));
            for (const outputDirectory of outputDirectories) {
                watchPath(outputDirectory, false);
            }
        } catch {
            handleWatcherError();
        }
    };

    const readRequiredOutputs = async () => {
        try {
            return await outputSnapshot(options.outputPaths);
        } catch {
            throw new Error(options.staleMessage);
        }
    };

    const assertFresh = async () => {
        if (inFlight) return inFlight;
        inFlight = (async () => {
            const currentOutputs = await readRequiredOutputs();
            if (!areSnapshotsEqual(requiredOutputSnapshot, currentOutputs)) isInvalidated = true;
            if (!isInvalidated && !isWatcherFailed) return;

            dispose();
            isInvalidated = false;
            await beginWatching();
            fullScanCount += 1;
            const io = new AsyncSemaphore(32);
            try {
                inputSnapshot = (
                    await mapWithConcurrency(options.inputPaths, 32, (path) =>
                        collectInputSnapshot(path, options.watchedDirectoryExtensions, true, io),
                    )
                ).flat();
            } catch {
                isInvalidated = true;
                throw new Error(options.staleMessage);
            }
            requiredOutputSnapshot = await readRequiredOutputs();
            const newestInputMtimeMs = inputSnapshot.reduce(
                (newest, entry) =>
                    entry.freshnessInput ? Math.max(newest, entry.mtimeMs) : newest,
                0,
            );
            const oldestOutputMtimeMs = Math.min(
                ...requiredOutputSnapshot.map((entry) => entry.mtimeMs),
            );
            if (newestInputMtimeMs > oldestOutputMtimeMs) {
                isInvalidated = true;
                throw new Error(options.staleMessage);
            }

            // A watcher event during the scan is deliberately retained so the next launch scans
            // again instead of trusting a cache captured while source or output files changed.
            // Intentionally not awaited: this IIFE result is cached in `inFlight` so concurrent
            // `assertFresh()` callers share the same in-progress scan. Awaiting here would block
            // returning the shared promise and defeat the deduplication this function exists for.
            // eslint-disable-next-line unicorn/prefer-await
        })().finally(() => {
            inFlight = undefined;
        });
        return inFlight;
    };

    return {
        assertFresh,
        dispose,
        get fullScanCount() {
            return fullScanCount;
        },
    };
}
