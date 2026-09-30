import { opendir } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * One `PRAGMA table_info` row; Codex's private schemas are capability-detected column by column.
 */
export interface SqliteColumn {
    name: string;
}

const MAX_CODEX_STATE_DIRECTORY_ENTRIES = 2_048;
export const MAX_CODEX_STATE_DATABASES = 32;

async function scanStateDirectory(
    directory: string,
    namePattern: RegExp,
    maximumEntries: number,
): Promise<{ candidates: string[]; scannedEntries: number }> {
    let handle: Awaited<ReturnType<typeof opendir>> | undefined;
    const candidates: string[] = [];
    let scannedEntries = 0;
    try {
        handle = await opendir(directory);
        for await (const entry of handle) {
            if (scannedEntries >= maximumEntries) return { candidates, scannedEntries };
            scannedEntries += 1;
            if (entry.isFile() && namePattern.test(entry.name))
                candidates.push(join(directory, entry.name));
        }
    } catch {
        // Missing or unreadable provider state is a normal capability miss.
    } finally {
        try {
            await handle?.close();
        } catch {
            // Async directory iteration already closes an exhausted handle.
        }
    }
    return { candidates, scannedEntries };
}

/**
 * Keeps provider-private database discovery bounded. Declared directory priority remains authoritative, with newest
 * names first inside each directory. Exhausting the budget fails closed instead of blocking Server Core while it
 * synchronously probes an arbitrary number of databases.
 */
export async function findCodexStateDatabases(
    directories: readonly string[],
    namePattern: RegExp = /^state_\d+\.sqlite$/,
): Promise<string[]> {
    const candidates: string[] = [];
    let scannedEntries = 0;
    const uniqueDirectories = [...new Set(directories)];
    for (const directory of uniqueDirectories) {
        if (scannedEntries >= MAX_CODEX_STATE_DIRECTORY_ENTRIES)
            return candidates.slice(0, MAX_CODEX_STATE_DATABASES);
        // eslint-disable-next-line no-await-in-loop -- directories share one global scan budget and priority order
        const scanned = await scanStateDirectory(
            directory,
            namePattern,
            MAX_CODEX_STATE_DIRECTORY_ENTRIES - scannedEntries,
        );
        candidates.push(
            ...newestCandidates(scanned.candidates, MAX_CODEX_STATE_DATABASES - candidates.length),
        );
        scannedEntries += scanned.scannedEntries;
        if (candidates.length >= MAX_CODEX_STATE_DATABASES) return candidates;
    }
    return candidates;
}

function newestCandidates(candidates: string[], maximum: number): string[] {
    return candidates
        .toSorted((left, right) =>
            basename(right).localeCompare(basename(left), undefined, { numeric: true }),
        )
        .slice(0, maximum);
}
