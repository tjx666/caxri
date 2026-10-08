import type * as FsPromises from 'node:fs/promises';
import { chmod, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `node:fs/promises` is a non-configurable ESM namespace, so `vi.spyOn` cannot count calls on it. The hoisted counter
 * lets the mock factory record every metadata `open` while delegating to the real filesystem.
 */
const counters = vi.hoisted(() => ({ open: 0, readdir: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof FsPromises>();
    return {
        ...actual,
        open: (...arguments_: Parameters<typeof actual.open>) => {
            counters.open += 1;
            return actual.open(...arguments_);
        },
        readdir: (...arguments_: Parameters<typeof actual.readdir>) => {
            counters.readdir += 1;
            return (actual.readdir as (...values: unknown[]) => unknown)(...arguments_);
        },
    };
});

import type { ClaudeSessionMetadata } from '../metadata-cache';
import {
    claudeMetadataCacheCounters,
    clearClaudeMetadataCache,
    readClaudeSessionMetadata,
} from '../metadata-cache';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    clearClaudeMetadataCache();
    counters.open = 0;
    counters.readdir = 0;
    const pending = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pending.map((path) => rm(path, { recursive: true, force: true })));
});

async function createConfigDirectory(): Promise<{ config: string; sessions: string }> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-metadata-cache-'));
    temporaryDirectories.push(directory);
    const config = join(directory, 'claude');
    const sessions = join(config, 'sessions');
    await mkdir(sessions, { recursive: true });
    return { config, sessions };
}

function sessionIds(entries: readonly ClaudeSessionMetadata[] | undefined): string[] {
    return (entries ?? [])
        .map((entry) => String(entry.sessionId))
        .toSorted((left, right) => left.localeCompare(right));
}

function metadataJson(sessionId: string, status: string): string {
    return JSON.stringify({ cwd: tmpdir(), sessionId, status, updatedAt: 1 });
}

describe('readClaudeSessionMetadata', () => {
    it('serves unchanged metadata files from the cache on the next probe', async () => {
        const { config, sessions } = await createConfigDirectory();
        await writeFile(join(sessions, 'a.json'), metadataJson('session-a', 'busy'), 'utf8');
        await writeFile(join(sessions, 'b.json'), metadataJson('session-b', 'idle'), 'utf8');

        const first = await readClaudeSessionMetadata(config);
        expect(sessionIds(first)).toEqual(['session-a', 'session-b']);
        expect(counters).toEqual({ open: 2, readdir: 1 });

        const second = await readClaudeSessionMetadata(config);
        expect(sessionIds(second)).toEqual(['session-a', 'session-b']);
        expect(counters).toEqual({ open: 2, readdir: 1 });
        expect(second?.[0]).toBe(first?.[0]);
    });

    it('re-reads only the file whose content changed and relists after an entry is added', async () => {
        const { config, sessions } = await createConfigDirectory();
        await writeFile(join(sessions, 'a.json'), metadataJson('session-a', 'busy'), 'utf8');
        await writeFile(join(sessions, 'b.json'), metadataJson('session-b', 'busy'), 'utf8');
        await readClaudeSessionMetadata(config);
        counters.open = 0;
        counters.readdir = 0;

        await writeFile(
            join(sessions, 'b.json'),
            metadataJson('session-b', 'idle-rewritten'),
            'utf8',
        );
        const rewritten = await readClaudeSessionMetadata(config);
        expect(rewritten?.find((entry) => entry.sessionId === 'session-b')?.status).toBe(
            'idle-rewritten',
        );
        expect(counters).toEqual({ open: 1, readdir: 0 });

        await writeFile(join(sessions, 'c.json'), metadataJson('session-c', 'busy'), 'utf8');
        const added = await readClaudeSessionMetadata(config);
        expect(sessionIds(added)).toEqual(['session-a', 'session-b', 'session-c']);
        expect(counters).toEqual({ open: 2, readdir: 1 });

        await rm(join(sessions, 'a.json'));
        const removed = await readClaudeSessionMetadata(config);
        expect(sessionIds(removed)).toEqual(['session-b', 'session-c']);
    });

    it('detects a same-size rewrite whose mtime moved within the same millisecond', async () => {
        const { config, sessions } = await createConfigDirectory();
        const path = join(sessions, 'a.json');
        await writeFile(path, metadataJson('session-a', 'busy'), 'utf8');
        const before = await stat(path, { bigint: true });
        expect((await readClaudeSessionMetadata(config))?.[0]?.status).toBe('busy');

        // Same byte length as `busy` so `size` cannot distinguish the revisions either.
        await writeFile(path, metadataJson('session-a', 'idle'), 'utf8');
        const millisecondStart = (before.mtimeNs / 1_000_000n) * 1_000_000n;
        const sameMillisecondNs =
            millisecondStart + ((before.mtimeNs - millisecondStart + 1_000n) % 1_000_000n);
        await utimes(path, Number(before.atimeNs) / 1e9, Number(sameMillisecondNs) / 1e9);
        const after = await stat(path, { bigint: true });
        expect(after.size).toBe(before.size);
        expect(Number(after.mtimeMs)).toBe(Number(before.mtimeMs));

        expect((await readClaudeSessionMetadata(config))?.[0]?.status).toBe('idle');
    });

    it('caches oversized and malformed files without re-opening them', async () => {
        const { config, sessions } = await createConfigDirectory();
        await writeFile(join(sessions, 'big.json'), `{}${' '.repeat(128 * 1024)}`, 'utf8');
        await writeFile(join(sessions, 'broken.json'), '{not json', 'utf8');
        await writeFile(join(sessions, 'ok.json'), metadataJson('session-ok', 'busy'), 'utf8');

        expect(sessionIds(await readClaudeSessionMetadata(config))).toEqual(['session-ok']);
        expect(counters.open).toBe(2);
        expect(sessionIds(await readClaudeSessionMetadata(config))).toEqual(['session-ok']);
        expect(counters.open).toBe(2);
    });

    /**
     * Several Terminals in one Project probe on the same PTY-activity burst, so on a cold cache they arrive together
     * and the cache, which only helps a probe that starts after an earlier one finished writing it, saves nothing. The
     * assertion is the syscall count rather than a timing: three probes, one `readdir` and one `open` per file.
     */
    it('scans the directory once for probes that arrive together on a cold cache', async () => {
        const { config, sessions } = await createConfigDirectory();
        await writeFile(join(sessions, 'a.json'), metadataJson('session-a', 'busy'), 'utf8');
        await writeFile(join(sessions, 'b.json'), metadataJson('session-b', 'idle'), 'utf8');

        const concurrent = await Promise.all([
            readClaudeSessionMetadata(config),
            readClaudeSessionMetadata(config),
            readClaudeSessionMetadata(config),
        ]);

        for (const entries of concurrent)
            expect(sessionIds(entries)).toEqual(['session-a', 'session-b']);
        expect(counters).toEqual({ open: 2, readdir: 1 });
    });

    it('returns undefined and forgets the directory when the sessions folder is missing', async () => {
        const { config, sessions } = await createConfigDirectory();
        await writeFile(join(sessions, 'a.json'), metadataJson('session-a', 'busy'), 'utf8');
        await readClaudeSessionMetadata(config);
        await rm(sessions, { recursive: true });
        await expect(readClaudeSessionMetadata(config)).resolves.toBeUndefined();
        await mkdir(sessions);
        await writeFile(join(sessions, 'b.json'), metadataJson('session-b', 'busy'), 'utf8');
        expect(sessionIds(await readClaudeSessionMetadata(config))).toEqual(['session-b']);
    });
});

describe('claudeMetadataCacheCounters', () => {
    it('separates a cold read, a hit, and a re-read forced by a changed file', async () => {
        const { config, sessions } = await createConfigDirectory();
        await writeFile(join(sessions, 'a.json'), metadataJson('session-a', 'busy'), 'utf8');
        await writeFile(join(sessions, 'b.json'), metadataJson('session-b', 'busy'), 'utf8');

        await readClaudeSessionMetadata(config);
        expect(claudeMetadataCacheCounters()).toMatchObject({
            cold: 2,
            file_changed: 0,
            hits: 0,
            listingReads: 1,
            misses: 2,
        });

        await readClaudeSessionMetadata(config);
        expect(claudeMetadataCacheCounters()).toMatchObject({
            hits: 2,
            // The listing is reused too, which a hit/miss ratio on its own would not show.
            listingReads: 1,
            misses: 2,
        });

        await writeFile(join(sessions, 'b.json'), metadataJson('session-b', 'idle'), 'utf8');
        await readClaudeSessionMetadata(config);
        expect(claudeMetadataCacheCounters()).toMatchObject({
            cold: 2,
            file_changed: 1,
            hits: 3,
            listingReads: 1,
            misses: 3,
        });
    });

    /**
     * A probe that could read nothing and a probe that served everything from cache both do zero reads. Without a
     * reason of its own, the unreadable directory is the one that looks healthy in the log.
     */
    it('counts a file it could not read at all, rather than passing over it silently', async () => {
        const { config, sessions } = await createConfigDirectory();
        const denied = join(sessions, 'a.json');
        await writeFile(denied, metadataJson('session-a', 'busy'), 'utf8');
        await writeFile(join(sessions, 'b.json'), metadataJson('session-b', 'busy'), 'utf8');
        await chmod(denied, 0o000);

        expect(sessionIds(await readClaudeSessionMetadata(config))).toEqual(['session-b']);
        expect(claudeMetadataCacheCounters()).toMatchObject({
            cold: 1,
            hits: 0,
            misses: 2,
            read_failed: 1,
        });
    });

    /**
     * A directory dropped to stay under the cache's own limit re-reads everything on its next probe, exactly like a
     * cold start. Reporting both as `cold` would hide the one of the two that is a capacity problem the operator can
     * act on, so the reason has to survive the eviction.
     */
    it('names a capacity eviction rather than reporting the re-read as a cold start', async () => {
        // One past the module's own `MAX_CACHED_SESSION_DIRECTORIES`, so the first directory is exactly the one dropped.
        const directories = await Promise.all(
            Array.from({ length: 9 }, async (_, index) => {
                const { config, sessions } = await createConfigDirectory();
                await writeFile(
                    join(sessions, 'a.json'),
                    metadataJson(`session-${index}`, 'busy'),
                    'utf8',
                );
                return config;
            }),
        );

        for (const config of directories)
            // eslint-disable-next-line no-await-in-loop -- eviction order is what this asserts
            await readClaudeSessionMetadata(config);
        expect(claudeMetadataCacheCounters()).toMatchObject({ capacity_evicted: 0, cold: 9 });

        await readClaudeSessionMetadata(directories[0]);
        expect(claudeMetadataCacheCounters()).toMatchObject({ capacity_evicted: 1, cold: 9 });
    });
});
