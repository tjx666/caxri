import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { StructuredLogger } from '../../../shared/node/logger';
import { CaxriDatabase } from '../../db/repository';
import { FileService } from '../service';

/**
 * `node:fs/promises` is a non-configurable ESM namespace, so `vi.spyOn` cannot patch `lstat` directly. `vi.hoisted`
 * exposes a settable override the mock factory reads per call, letting one test simulate an entry that vanishes (or
 * fails to stat) mid-listing while every other test keeps the real filesystem behavior.
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
            return (
                overridden ?? (actual.lstat as (...arguments_: unknown[]) => unknown)(path, ...rest)
            );
        },
    };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const paths = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

describe('FileService watcher and polling behavior', () => {
    it('keeps visible dependency directories out of fallback polling', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-tree-poll-excludes-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const dependencies = join(root, 'node_modules');
        await mkdir(dependencies, { recursive: true });
        await writeFile(join(dependencies, 'existing.js'), 'existing', 'utf8');
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
            {
                pollIntervalMs: 30,
                subscribe: () => Promise.reject(new Error('native watcher unavailable')),
            },
        );

        await service.watchSession(session.id);
        await service.list(session.id, dependencies);
        const rootFile = join(root, 'root-change.ts');
        const dependencyFile = join(dependencies, 'dependency-change.js');
        await Promise.all([
            writeFile(rootFile, 'root', 'utf8'),
            writeFile(dependencyFile, 'dependency', 'utf8'),
        ]);
        const canonicalRootFile = await realpath(rootFile);
        const canonicalDependencyFile = await realpath(dependencyFile);

        await expect.poll(() => events, { timeout: 3_000 }).toContain(canonicalRootFile);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(events).not.toContain(canonicalDependencyFile);
        await service.close();
        database.close();
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
            () => {},
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
            { pollIntervalMs: 50 },
        );
        await service.watchSession(session.id);
        await writeFile(watchedPath, 'after', 'utf8');

        await expect.poll(() => events.length, { timeout: 5_000 }).toBeGreaterThan(0);
        /**
         * Wait beyond a complete polling interval so the native event cannot be replayed as a phantom change.
         */
        await new Promise((resolve) => setTimeout(resolve, 150));
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
            return;
        });
        const service = new FileService(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
            {
                pollIntervalMs: 20,
                subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
            },
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
