import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

export interface BuildFreshnessOptions {
    inputPaths: string[];
    outputPaths: string[];
    watchedDirectoryExtensions: ReadonlySet<string>;
    staleMessage: string;
}

async function newestInputMtimeMs(
    path: string,
    watchedDirectoryExtensions: ReadonlySet<string>,
    explicit: boolean,
): Promise<number> {
    let entries: Dirent[];
    try {
        const metadata = await stat(path);
        if (metadata.isFile())
            return explicit || watchedDirectoryExtensions.has(extname(path)) ? metadata.mtimeMs : 0;
        if (!metadata.isDirectory()) return 0;
        entries = await readdir(path, { withFileTypes: true });
    } catch {
        return 0;
    }

    let newest = 0;
    for (const entry of entries) {
        const entryPath = join(path, entry.name);
        if (entry.isDirectory()) {
            newest = Math.max(
                newest,
                await newestInputMtimeMs(entryPath, watchedDirectoryExtensions, false),
            );
        } else if (entry.isFile() && watchedDirectoryExtensions.has(extname(entry.name))) {
            newest = Math.max(newest, (await stat(entryPath)).mtimeMs);
        }
    }
    return newest;
}

/**
 * Rejects focused E2E runs when any declared build input is newer than the oldest required output.
 * Comparing every process entry prevents a fresh Main bundle from masking a stale Runtime, preload,
 * or Renderer bundle.
 */
export async function assertBuildOutputsFresh(options: BuildFreshnessOptions): Promise<void> {
    let oldestOutputMtimeMs = Number.POSITIVE_INFINITY;
    try {
        for (const path of options.outputPaths)
            oldestOutputMtimeMs = Math.min(oldestOutputMtimeMs, (await stat(path)).mtimeMs);
    } catch {
        throw new Error(options.staleMessage);
    }

    let newestBuildInputMtimeMs = 0;
    for (const path of options.inputPaths) {
        newestBuildInputMtimeMs = Math.max(
            newestBuildInputMtimeMs,
            await newestInputMtimeMs(path, options.watchedDirectoryExtensions, true),
        );
    }
    if (newestBuildInputMtimeMs > oldestOutputMtimeMs) throw new Error(options.staleMessage);
}
