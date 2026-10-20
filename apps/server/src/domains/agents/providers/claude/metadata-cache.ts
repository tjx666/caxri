import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { isCaxriError } from '@caxri/protocol';
import { fileIdentity, mapWithConcurrency, SingleFlight } from '@caxri/system';

import { readBoundedRegularFileText } from '../../../bounded-file-reader';
import type { AgentProbeCacheCounters } from '../../contract';

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
 * each time (issue #556). A file is now re-read only when its {@link fileIdentity} changes. The listing itself is reused
 * while the directory's own identity is unchanged, which is exact rather than a TTL: any entry add, remove, or rename
 * bumps the directory mtime, while an in-place rewrite is caught by the per-file stat.
 */
const sessionDirectoryCaches = new Map<string, CachedSessionsDirectory>();

/**
 * In-flight reads keyed by sessions directory, so probes racing a cold cache scan it once between them. Entries evict
 * themselves when the read settles, so this never holds a result past the probe that started it.
 */
const directoryReads = new SingleFlight<string, readonly ClaudeSessionMetadata[] | undefined>();

/**
 * Why a metadata file had to be read from disk instead of served from the cache. Closed so "the hit rate fell" is a
 * question the log can answer on its own: each reason points at a different repair, and the counts distinguish them
 * even when they happen together.
 */
type ClaudeMetadataCacheMissReason =
    /**
     * The file had no cached entry: a first probe of this config directory, or a session file Claude just created.
     */
    | 'cold'
    /**
     * The file's identity moved, which is the cache working as designed: Claude rewrote the session's `status`.
     */
    | 'file_changed'
    /**
     * The whole per-directory cache was dropped to stay under {@link MAX_CACHED_SESSION_DIRECTORIES}. Unlike the other
     * reasons this one is a capacity problem rather than a change on disk: a sustained count here means the limit is
     * too low for how many config directories this process actually probes, and every probe is paying a cold start.
     */
    | 'capacity_evicted'
    /**
     * The read raced an in-place rewrite, so the parsed result was deliberately not cached. Persistent counts mean the
     * probe keeps landing inside Claude's writes, which costs a re-read on every probe of that file.
     */
    | 'write_raced'
    /**
     * The file could not be read at all: it was rotated away between the listing and the `stat`, or its permissions
     * deny this process. Counted as a miss rather than passed over, because a probe that reached no file at all and a
     * probe that served everything from cache both report zero reads; without this the log cannot tell them apart.
     */
    | 'read_failed';

/**
 * The shared probe-cache fields plus one counter per miss reason. Cumulative rather than per-probe: probes for
 * different Terminals overlap, so a delta measured around one of them would attribute another's disk work to it. An
 * aggregate read after a probe is exact under any interleaving, and the rate an operator actually wants is a slope
 * across `agent.probe` records, not a single line's number.
 */
export type ClaudeMetadataCacheCounters = AgentProbeCacheCounters &
    Record<ClaudeMetadataCacheMissReason, number>;

function emptyCounters(): ClaudeMetadataCacheCounters {
    return {
        capacity_evicted: 0,
        cold: 0,
        file_changed: 0,
        hits: 0,
        listingReads: 0,
        misses: 0,
        read_failed: 0,
        write_raced: 0,
    };
}

const counters = emptyCounters();

/**
 * Directories whose cache was dropped for capacity, so the next probe of one can name that as the reason it re-read
 * every file rather than reporting a cold start. Bounded by the cache's own limit: past that many evictions, the drop
 * is too far back to still be the explanation.
 */
const evictedDirectories = new Set<string>();

/**
 * A snapshot of the process-lifetime cache accounting. Diagnostics only: nothing here feeds a probe result.
 */
export function claudeMetadataCacheCounters(): ClaudeMetadataCacheCounters {
    return { ...counters };
}

/**
 * Resets every piece of state this module owns, for a test or benchmark that needs a cold cache. The in-flight reads go
 * too: a load started before the reset was answering the state it discarded, so a caller arriving after must scan again
 * rather than join it.
 */
export function clearClaudeMetadataCache(): void {
    sessionDirectoryCaches.clear();
    evictedDirectories.clear();
    directoryReads.clear();
    Object.assign(counters, emptyCounters());
}

function recordMiss(reason: ClaudeMetadataCacheMissReason): void {
    counters.misses += 1;
    counters[reason] += 1;
}

/**
 * Copies only the fields the probe reads so a cached entry costs a few hundred bytes regardless of how much else the
 * provider writes into the file.
 */
function projectMetadata(parsed: ClaudeSessionMetadata): ClaudeSessionMetadata {
    const { cwd, name, nameSource, sessionId, startedAt, status, updatedAt } = parsed;
    return { cwd, name, nameSource, sessionId, startedAt, status, updatedAt };
}

/**
 * The shared bounded reader owns the open, so an entry swapped for a FIFO between the listing and the read is refused
 * instead of parking the probe on a writer that never comes. An oversized file, including one that grew past the cap
 * after the identity `stat`, is an answer rather than a fault: it caches as empty like a malformed one. Any other
 * rejection propagates so the caller drops the entry as `read_failed`.
 */
async function parseMetadataFile(
    path: string,
    size: bigint,
): Promise<ClaudeSessionMetadata | undefined> {
    if (size > BigInt(MAX_CLAUDE_METADATA_BYTES)) return undefined;
    let source: string;
    try {
        source = await readBoundedRegularFileText(path, MAX_CLAUDE_METADATA_BYTES);
    } catch (error) {
        if (isCaxriError(error) && error.code === 'CAPACITY') return undefined;
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(source);
    } catch {
        // A half-written or malformed file stays cached as empty until Claude Code rewrites it.
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return projectMetadata(parsed);
}

/**
 * Returns the cache for `directory` alongside the reason a file in it would have no cached entry, so a capacity
 * eviction is not reported as an ordinary cold start.
 */
function sessionDirectoryCache(directory: string): {
    cache: CachedSessionsDirectory;
    uncachedReason: ClaudeMetadataCacheMissReason;
} {
    const existing = sessionDirectoryCaches.get(directory);
    if (existing) return { cache: existing, uncachedReason: 'cold' };
    const cache: CachedSessionsDirectory = { files: new Map(), names: [] };
    sessionDirectoryCaches.set(directory, cache);
    if (sessionDirectoryCaches.size > MAX_CACHED_SESSION_DIRECTORIES) {
        const oldest = sessionDirectoryCaches.keys().next().value;
        if (oldest !== undefined) {
            sessionDirectoryCaches.delete(oldest);
            evictedDirectories.add(oldest);
            if (evictedDirectories.size > MAX_CACHED_SESSION_DIRECTORIES) {
                const stale = evictedDirectories.keys().next().value;
                if (stale !== undefined) evictedDirectories.delete(stale);
            }
        }
    }
    return {
        cache,
        uncachedReason: evictedDirectories.delete(directory) ? 'capacity_evicted' : 'cold',
    };
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
    // Counted only once the listing actually came back, so a directory that cannot be read is not a rebuilt listing.
    counters.listingReads += 1;
    const present = new Set(names);
    for (const name of cache.files.keys()) if (!present.has(name)) cache.files.delete(name);
    cache.identity = identity;
    cache.names = names;
    return names;
}

async function readSessionsDirectory(
    directory: string,
): Promise<readonly ClaudeSessionMetadata[] | undefined> {
    const { cache, uncachedReason } = sessionDirectoryCache(directory);
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
                if (cached?.identity === identity) {
                    counters.hits += 1;
                    return cached.metadata;
                }
                const metadata = await parseMetadataFile(path, stats.size);
                /**
                 * Claude Code rewrites metadata in place; a write landing between the identity stat and the read would
                 * otherwise pin stale content under the newer identity, so only an unchanged identity is cached.
                 */
                if (fileIdentity(await stat(path, { bigint: true })) === identity) {
                    cache.files.set(name, { identity, metadata });
                    recordMiss(cached ? 'file_changed' : uncachedReason);
                } else {
                    cache.files.delete(name);
                    recordMiss('write_raced');
                }
                return metadata;
            } catch {
                cache.files.delete(name);
                recordMiss('read_failed');
                return;
            }
        },
    );
    return entries.filter((metadata) => metadata !== undefined);
}

/**
 * Reads every parseable live-session metadata file below `configDirectory/sessions`, serving unchanged files from the
 * identity-keyed cache. Returns `undefined` when the directory cannot be listed, matching the pre-cache capability
 * miss.
 *
 * Concurrent callers for one directory share a single read. The cache only helps a probe that arrives after an earlier
 * one finished writing it; several Terminals in one Project probe on the same PTY-activity burst, so on a cold cache
 * they all miss and all scan. Merging here rather than around the whole Agent snapshot is deliberate: this call takes
 * nothing but the config directory, while a snapshot carries the Terminal's own `agentSessionId`,
 * `excludedAgentSessionIds`, `startedAt`, and `shellPid`, which select _which_ session it may claim. Sharing at that
 * level would hand one Terminal another's selection.
 */
export function readClaudeSessionMetadata(
    configDirectory: string,
): Promise<readonly ClaudeSessionMetadata[] | undefined> {
    const directory = join(configDirectory, 'sessions');
    return directoryReads.run(directory, () => readSessionsDirectory(directory));
}
