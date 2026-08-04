import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../database';
import { FileService } from '../files';
import { StructuredLogger } from '../logger';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('FileService', () => {
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
        const watchedPath = join(root, 'watched.txt');
        await writeFile(watchedPath, 'first', 'utf8');
        await writeFile(watchedPath, 'second', 'utf8');
        const canonicalWatchedPath = await realpath(watchedPath);

        await expect.poll(() => events.length, { timeout: 5_000 }).toBeGreaterThan(0);
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(events).toEqual([canonicalWatchedPath]);
        await service.close();
        database.close();
    });
});
