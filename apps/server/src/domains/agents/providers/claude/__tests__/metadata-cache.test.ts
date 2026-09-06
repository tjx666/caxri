import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
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

import type { BigIntStats } from 'node:fs';

import type { ClaudeSessionMetadata } from '../metadata-cache';
import {
    clearClaudeMetadataCache,
    fileIdentity,
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

describe('fileIdentity', () => {
    it('separates revisions that differ only below one millisecond', () => {
        const base = {
            ctimeNs: 1_788_580_529_659_183_087n,
            dev: 1n,
            ino: 2n,
            mtimeNs: 1_788_580_529_659_183_087n,
            size: 64n,
        } as BigIntStats;
        const sameMillisecond = {
            ...base,
            ctimeNs: base.ctimeNs + 1_000n,
            mtimeNs: base.mtimeNs + 1_000n,
        };
        expect(fileIdentity(sameMillisecond)).not.toBe(fileIdentity(base));
        expect(fileIdentity({ ...base })).toBe(fileIdentity(base));
    });
});

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
