import { Buffer } from 'node:buffer';
import type { BigIntStats } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { mapWithConcurrency } from '@caxri/system';

export interface ClaudeSessionMetadata {
    cwd?: unknown;
    name?: unknown;
    nameSource?: unknown;
    sessionId?: unknown;
    startedAt?: unknown;
    status?: unknown;
    updatedAt?: unknown;
}

interface CachedMetadataFile {
    identity: string;
    /**
     * `undefined` records an oversized or malformed file so an unchanged one is not re-read on every probe.
     */
    metadata: ClaudeSessionMetadata | undefined;
}

interface CachedSessionsDirectory {
    files: Map<string, CachedMetadataFile>;
    identity?: string;
    names: string[];
}

const MAX_CLAUDE_METADATA_BYTES = 128 * 1024;
const MAX_CLAUDE_METADATA_FILES = 512;
const MAX_CONCURRENT_CLAUDE_READS = 8;
const MAX_CACHED_SESSION_DIRECTORIES = 8;

/**
 * Per-config-directory cache of parsed `sessions/*.json` metadata keyed by file identity.
 *
 * Probes fire after every 2-second burst of PTY activity and previously re-read and re-`realpath`ed up to 512 files
 * each time (issue #556). A file is now re-read only when its identity changes. Identity uses nanosecond `mtimeNs` plus
 * `ctimeNs`, `size`, `dev`, and `ino` (see `git/repo.ts`): Claude Code rewrites the `status` field within the same
 * millisecond, and that field drives the sidebar attention cue, so a millisecond key would publish stale state. The
 * listing itself is reused while the directory's own identity is unchanged, which is exact rather than a TTL: any entry
 * add, remove, or rename bumps the directory mtime, while an in-place rewrite is caught by the per-file stat.
 */
const sessionDirectoryCaches = new Map<string, CachedSessionsDirectory>();

export function clearClaudeMetadataCache(): void {
    sessionDirectoryCaches.clear();
}

export function fileIdentity(stats: BigIntStats): string {
    return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join('\0');
}

/**
 * Copies only the fields the probe reads so a cached entry costs a few hundred bytes regardless of how much else the
 * provider writes into the file.
 */
function projectMetadata(parsed: ClaudeSessionMetadata): ClaudeSessionMetadata {
    const { cwd, name, nameSource, sessionId, startedAt, status, updatedAt } = parsed;
    return { cwd, name, nameSource, sessionId, startedAt, status, updatedAt };
}

async function parseMetadataFile(
    path: string,
    size: bigint,
): Promise<ClaudeSessionMetadata | undefined> {
    if (size > BigInt(MAX_CLAUDE_METADATA_BYTES)) return undefined;
    const handle = await open(path, 'r');
    let parsed: unknown;
    try {
        const buffer = Buffer.allocUnsafe(MAX_CLAUDE_METADATA_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_CLAUDE_METADATA_BYTES) return undefined;
        try {
            parsed = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
        } catch {
            // A half-written or malformed file stays cached as empty until Claude Code rewrites it.
            return undefined;
        }
    } finally {
        await handle.close();
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return projectMetadata(parsed);
}

function sessionDirectoryCache(directory: string): CachedSessionsDirectory {
    let cache = sessionDirectoryCaches.get(directory);
    if (!cache) {
        cache = { files: new Map(), names: [] };
        sessionDirectoryCaches.set(directory, cache);
        if (sessionDirectoryCaches.size > MAX_CACHED_SESSION_DIRECTORIES) {
            const oldest = sessionDirectoryCaches.keys().next().value;
            if (oldest !== undefined) sessionDirectoryCaches.delete(oldest);
        }
    }
    return cache;
}

async function listMetadataFiles(
    directory: string,
    cache: CachedSessionsDirectory,
): Promise<string[] | undefined> {
    let identity: string;
    try {
        identity = fileIdentity(await stat(directory, { bigint: true }));
    } catch {
        return undefined;
    }
    if (cache.identity === identity) return cache.names;
    const names: string[] = [];
    try {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
            names.push(entry.name);
            if (names.length === MAX_CLAUDE_METADATA_FILES) break;
        }
    } catch {
        return undefined;
    }
    const present = new Set(names);
    for (const name of cache.files.keys()) if (!present.has(name)) cache.files.delete(name);
    cache.identity = identity;
    cache.names = names;
    return names;
}

/**
 * Reads every parseable live-session metadata file below `configDirectory/sessions`, serving unchanged files from the
 * identity-keyed cache. Returns `undefined` when the directory cannot be listed, matching the pre-cache capability
 * miss.
 */
export async function readClaudeSessionMetadata(
    configDirectory: string,
): Promise<ClaudeSessionMetadata[] | undefined> {
    const directory = join(configDirectory, 'sessions');
    const cache = sessionDirectoryCache(directory);
    const names = await listMetadataFiles(directory, cache);
    if (!names) {
        sessionDirectoryCaches.delete(directory);
        return undefined;
    }
    const entries = await mapWithConcurrency<string, ClaudeSessionMetadata | undefined>(
        names,
        MAX_CONCURRENT_CLAUDE_READS,
        async (name) => {
            const path = join(directory, name);
            try {
                const stats = await stat(path, { bigint: true });
                const identity = fileIdentity(stats);
                const cached = cache.files.get(name);
                if (cached?.identity === identity) return cached.metadata;
                const metadata = await parseMetadataFile(path, stats.size);
                /**
                 * Claude Code rewrites metadata in place; a write landing between the identity stat and the read would
                 * otherwise pin stale content under the newer identity, so only an unchanged identity is cached.
                 */
                if (fileIdentity(await stat(path, { bigint: true })) === identity)
                    cache.files.set(name, { identity, metadata });
                else cache.files.delete(name);
                return metadata;
            } catch {
                cache.files.delete(name);
                return;
            }
        },
    );
    return entries.filter((metadata) => metadata !== undefined);
}
