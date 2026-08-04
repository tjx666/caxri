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

import { CaxriDatabase } from '../database';
import { FileService, rememberChangeFingerprint, rememberPolledDirectory } from '../files';
import { StructuredLogger } from '../logger';

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

    it('reads and writes text under the Session root and rejects traversal/symlink escapes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-files-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const outside = join(directory, 'outside.txt');
        await mkdir(root);
        await writeFile(join(root, 'hello.txt'), 'hello', 'utf8');
        await writeFile(outside, 'secret', 'utf8');
        await symlink(outside, join(root, 'escape.txt'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(root, 'shell').session;
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
        const session = database.createSession(directory, 'shell').session;
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
        const session = database.createSession(directory, 'shell').session;
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
        const session = database.createSession(directory, 'shell').session;
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
        const session = database.createSession(root, 'shell').session;
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
        const session = database.createSession(root, 'shell').session;
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

    it('shares concurrent directory reads and records one timed file-list operation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-files-list-'));
        temporaryDirectories.push(directory);
        await writeFile(join(directory, 'one.txt'), 'one', 'utf8');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(directory, 'shell').session;
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
        const session = database.createSession(root, 'shell').session;
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

    it('rebinds fallback polling when Session watcher setup completes out of order', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-watch-switch-'));
        temporaryDirectories.push(directory);
        const firstRoot = join(directory, 'first');
        const secondRoot = join(directory, 'second');
        await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const first = database.createSession(firstRoot, 'shell').session;
        const second = database.createSession(secondRoot, 'shell').session;
        const events: string[] = [];
        const service = new FileService(
            database,
            (event) => {
                if (event.event === 'files.changed' && event.payload.sessionId === second.id)
                    events.push(...event.payload.changes.map((change) => change.path));
            },
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
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
        const internals = service as unknown as {
            watcher?: { unsubscribe(): Promise<void> };
        };
        await internals.watcher?.unsubscribe();
        internals.watcher = undefined;
        const changedPath = join(secondRoot, 'polled.txt');
        await writeFile(changedPath, 'poll me', 'utf8');
        const canonicalChangedPath = await realpath(changedPath);

        await expect.poll(() => events.length, { timeout: 3_000 }).toBeGreaterThan(0);
        expect(events).toEqual([canonicalChangedPath]);
        await service.close();
        database.close();
    });
});
