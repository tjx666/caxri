import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { AsyncSemaphore, mapWithConcurrency } from '../process/concurrency.js';

export interface BuildFreshnessOptions {
    inputPaths: string[];
    outputPaths: string[];
    watchedDirectoryExtensions: ReadonlySet<string>;
    staleMessage: string;
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

/**
 * Rejects focused E2E runs when any declared build input is newer than the oldest required output. Comparing every
 * process entry prevents a fresh Main bundle from masking a stale Runtime, preload, or Renderer bundle.
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
