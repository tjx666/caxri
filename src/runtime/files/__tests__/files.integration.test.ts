import type * as FsPromises from 'node:fs/promises';
import {
    mkdir,
    mkdtemp,
    open,
    readFile,
    realpath,
    rename,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { StructuredLogger } from '../../../shared/node/logger';
import { CaxriDatabase } from '../../database';
import { FileService, rememberChangeFingerprint, rememberPolledDirectory } from '..';

/**
 * `node:fs/promises` is a non-configurable ESM namespace, so `vi.spyOn` cannot patch `lstat`
 * directly. `vi.hoisted` exposes a settable override the mock factory reads per call, letting one
 * test simulate an entry that vanishes (or fails to stat) mid-listing while every other test keeps
 * the real filesystem behavior.
 */
const { setLstatOverride, getLstatOverride } = vi.hoisted(() => {
    let override: ((path: string) => Promise<unknown> | undefined) | undefined;
    return {
        getLstatOverride: () => override,
        setLstatOverride: (value: typeof override) => {
            override = value;
        },
    };
});
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof FsPromises>();
    return {
        ...actual,
        lstat: (path: Parameters<typeof actual.lstat>[0], ...rest: unknown[]) => {
            const overridden = typeof path === 'string' ? getLstatOverride()?.(path) : undefined;
            return overridden ?? (actual.lstat as (...args: unknown[]) => unknown)(path, ...rest);
        },
    };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('FileService', () => {
    it('keeps fallback polling bounded without evicting the active root', () => {
        const directories = new Map<string, string>();
        rememberPolledDirectory(directories, '/root', 'root', '/root', 3);
        rememberPolledDirectory(directories, '/root/a', 'a', '/root', 3);
        rememberPolledDirectory(directories, '/root/b', 'b', '/root', 3);
        rememberPolledDirectory(directories, '/root/c', 'c', '/root', 3);

        expect([...directories.keys()]).toEqual(['/root', '/root/b', '/root/c']);
    });

    it('deduplicates the same file version across native and polling backends', () => {
        const fingerprints = new Map<string, string>();

        expect(rememberChangeFingerprint(fingerprints, '/root/file.ts', 'version-1', 3)).toBe(true);
        expect(rememberChangeFingerprint(fingerprints, '/root/file.ts', 'version-1', 3)).toBe(
            false,
        );
        expect(rememberChangeFingerprint(fingerprints, '/root/file.ts', 'version-2', 3)).toBe(true);
    });

    it('reads and writes text under the Project root and rejects traversal/symlink escapes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-files-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const outside = join(directory, 'outside.txt');
        await mkdir(root);
        await writeFile(join(root, 'hello.txt'), 'hello', 'utf8');
        await writeFile(outside, 'secret', 'utf8');
        await symlink(outside, join(root, 'escape.txt'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        const service = new FileService(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
        );
        expect((await service.read(session.id, join(root, 'hello.txt'))).content).toBe('hello');
        expect((await service.write(session.id, join(root, 'hello.txt'), 'updated')).content).toBe(
            'updated',
        );
        await expect(service.read(session.id, outside)).rejects.toThrow('outside');
        await expect(service.read(session.id, join(root, 'escape.txt'))).rejects.toThrow('outside');
        database.close();
    });

    it('accepts root children whose names begin with two dots', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-files-dotdot-name-'));
        temporaryDirectories.push(directory);
        const path = join(directory, '..odd.txt');
        await writeFile(path, 'valid child', 'utf8');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const service = new FileService(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
        );

        await expect(service.read(session.id, path)).resolves.toMatchObject({
            content: 'valid child',
        });
        database.close();
    });

    it('refuses binary and oversized files', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-limits-'));
        temporaryDirectories.push(directory);
        await writeFile(join(directory, 'binary.bin'), Buffer.from([1, 0, 2]));
        await writeFile(join(directory, 'large.txt'), 'x'.repeat(2048));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const service = new FileService(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
        );
        await expect(service.read(session.id, join(directory, 'binary.bin'))).rejects.toThrow(
            'Binary',
        );
        await expect(service.read(session.id, join(directory, 'large.txt'))).rejects.toThrow(
            'safety limit',
        );
        database.close();
    });

    it('rejects an oversized save before changing the file on disk', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-write-limit-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'note.txt');
        await writeFile(path, 'unchanged', 'utf8');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const service = new FileService(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
        );

        await expect(service.write(session.id, path, 'x'.repeat(1_100))).rejects.toThrow(
            'write safety limit',
        );
        await expect(readFile(path, 'utf8')).resolves.toBe('unchanged');
        database.close();
    });

    it('rejects a symlink replacement between validation and opening a file', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-read-race-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const target = join(root, 'target.txt');
        const original = join(root, 'original.txt');
        const outside = join(directory, 'outside.txt');
        await mkdir(root);
        await writeFile(target, 'inside', 'utf8');
        await writeFile(outside, 'secret', 'utf8');
        const canonicalTarget = await realpath(target);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        let replaced = false;
        const service = new FileService(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
            {
                openFile: async (path, flags, mode) => {
                    if (path === canonicalTarget && !replaced) {
                        replaced = true;
                        await rename(target, original);
                        await symlink(outside, target);
                    }
                    return open(path, flags, mode);
                },
            },
        );

        await expect(service.read(session.id, target)).rejects.toThrow();
        expect(await readFile(outside, 'utf8')).toBe('secret');
        database.close();
    });

    it('does not enumerate an outside directory swapped in after path validation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-directory-list-race-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const original = join(directory, 'original-project');
        const outside = join(directory, 'outside');
        await Promise.all([mkdir(root), mkdir(outside)]);
        await writeFile(join(root, 'inside.txt'), 'inside', 'utf8');
        await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        const service = new FileService(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
        );
        const resolvePath = service.resolveSessionPath.bind(service);
        vi.spyOn(service, 'resolveSessionPath').mockImplementationOnce(async (...args) => {
            const resolved = await resolvePath(...args);
            await rename(root, original);
            await symlink(outside, root);
            return resolved;
        });

        await expect(service.list(session.id)).rejects.toThrow();
        database.close();
    });

    it('tolerates entries that vanish or fail to stat instead of failing the whole listing', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-files-vanish-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await mkdir(root);
        await writeFile(join(root, 'stays.txt'), 'stays', 'utf8');
        await writeFile(join(root, 'vanishes.txt'), 'vanishes', 'utf8');
        await writeFile(join(root, 'unreadable.txt'), 'unreadable', 'utf8');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        const logger = new StructuredLogger(join(directory, 'logs'));
        const service = new FileService(
            database,
            () => undefined,
            logger,
            () => 1024,
        );
        /** Simulates a file that an AI agent deletes (ENOENT) or a file that briefly fails to stat mid-listing. */
        setLstatOverride((path) => {
            if (path.endsWith('vanishes.txt'))
                return Promise.reject(
                    Object.assign(new Error('ENOENT: no such file or directory'), {
                        code: 'ENOENT',
                    }),
                );
            if (path.endsWith('unreadable.txt'))
                return Promise.reject(
                    Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
                );
            return undefined;
        });

        try {
            const entries = await service.list(session.id);
            expect(entries.map((entry) => entry.name)).toEqual(['stays.txt']);
            const records = (await readFile(logger.path, 'utf8'))
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as { event: string; fields?: { path?: string } });
            const skipped = records.filter((record) => record.event === 'file.list_entry_skipped');
            expect(skipped).toHaveLength(1);
            expect(skipped[0].fields?.path).toContain('unreadable.txt');
        } finally {
            setLstatOverride(undefined);
            database.close();
        }
    });

    it('shares concurrent directory reads and records one timed file-list operation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-files-list-'));
        temporaryDirectories.push(directory);
        await writeFile(join(directory, 'one.txt'), 'one', 'utf8');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const logger = new StructuredLogger(join(directory, 'logs'));
        const service = new FileService(
            database,
            () => undefined,
            logger,
            () => 1024,
        );

        const listings = await Promise.all([service.list(session.id), service.list(session.id)]);
        expect(listings[0]).toEqual(listings[1]);
        const records = (await readFile(logger.path, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { event: string; durationMs?: number });
        const listRecords = records.filter((record) => record.event === 'file.list');
        expect(listRecords).toHaveLength(1);
        expect(listRecords[0].durationMs).toBeTypeOf('number');
        database.close();
    });

    it('coalesces watcher bursts for the active Session', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-watch-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await mkdir(root);
        const watchedPath = join(root, 'watched.txt');
        await writeFile(watchedPath, 'before', 'utf8');
        const canonicalWatchedPath = await realpath(watchedPath);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        const events: string[] = [];
        const service = new FileService(
            database,
            (event) => {
                if (event.event === 'files.changed')
                    events.push(...event.payload.changes.map((change) => change.path));
            },
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
        );
        await service.watchSession(session.id);
        await writeFile(watchedPath, 'after', 'utf8');

        await expect.poll(() => events.length, { timeout: 5_000 }).toBeGreaterThan(0);
        /** Wait beyond a complete polling interval so the native event cannot be replayed as a phantom change. */
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        expect(events).toEqual([canonicalWatchedPath]);
        await service.close();
        database.close();
    });

    it('does not poll while the native watcher remains healthy', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-native-only-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await mkdir(root);
        await writeFile(join(root, 'watched.txt'), 'before', 'utf8');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        let lstatCount = 0;
        setLstatOverride(() => {
            lstatCount += 1;
            return undefined;
        });
        const service = new FileService(
            database,
            () => undefined,
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
            { pollIntervalMs: 20 },
        );

        try {
            await service.watchSession(session.id);
            const afterSetup = lstatCount;
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(lstatCount).toBe(afterSetup);
        } finally {
            setLstatOverride(undefined);
            await service.close();
            database.close();
        }
    });

    it('retains directories expanded before a delayed native watcher failure', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-delayed-fallback-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const expanded = join(root, 'expanded');
        const watchedPath = join(expanded, 'watched.txt');
        await mkdir(expanded, { recursive: true });
        await writeFile(watchedPath, 'before', 'utf8');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        const events: string[] = [];
        const subscription = Promise.withResolvers<never>();
        const subscribe = vi.fn(() => subscription.promise);
        const service = new FileService(
            database,
            (event) => {
                if (event.event === 'files.changed')
                    events.push(...event.payload.changes.map((change) => change.path));
            },
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
            { pollIntervalMs: 50, subscribe },
        );

        const setup = service.watchSession(session.id);
        await expect.poll(() => subscribe.mock.calls.length).toBe(1);
        await service.list(session.id, expanded);
        subscription.reject(new Error('native watcher failed after listing'));
        await setup;
        await writeFile(watchedPath, 'after', 'utf8');

        await expect.poll(() => events, { timeout: 3_000 }).toContain(await realpath(watchedPath));
        await service.close();
        database.close();
    });

    it('rebinds fallback polling when Session watcher setup completes out of order', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-watch-switch-'));
        temporaryDirectories.push(directory);
        const firstRoot = join(directory, 'first');
        const secondRoot = join(directory, 'second');
        await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const first = database.createSession(database.createProject(firstRoot).id, 'shell').session;
        const second = database.createSession(
            database.createProject(secondRoot).id,
            'shell',
        ).session;
        const events: string[] = [];
        const service = new FileService(
            database,
            (event) => {
                if (event.event === 'files.changed' && event.payload.sessionId === second.id)
                    events.push(...event.payload.changes.map((change) => change.path));
            },
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
            {
                pollIntervalMs: 50,
                subscribe: () => Promise.reject(new Error('native watcher unavailable')),
            },
        );
        const originalResolve = service.resolveSessionPath.bind(service);
        const firstGate = Promise.withResolvers<void>();
        const secondGate = Promise.withResolvers<void>();
        vi.spyOn(service, 'resolveSessionPath').mockImplementation(async (sessionId, input) => {
            if (input === undefined)
                await (sessionId === first.id ? firstGate.promise : secondGate.promise);
            return originalResolve(sessionId, input);
        });

        const firstSetup = service.watchSession(first.id);
        const secondSetup = service.watchSession(second.id);
        firstGate.resolve();
        await firstSetup;
        secondGate.resolve();
        await secondSetup;
        const changedPath = join(secondRoot, 'polled.txt');
        await writeFile(changedPath, 'poll me', 'utf8');
        const canonicalChangedPath = await realpath(changedPath);

        await expect.poll(() => events.length, { timeout: 3_000 }).toBeGreaterThan(0);
        expect(events).toEqual([canonicalChangedPath]);
        await service.close();
        database.close();
    });
});
