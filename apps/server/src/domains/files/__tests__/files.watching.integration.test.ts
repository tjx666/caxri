import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import type parcelWatcher from '@parcel/watcher';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createEventGate,
    createWatchDiagnosticHub,
    createWatchFailureProbe,
} from '../../../__tests__/support/watch-diagnostics';
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
const loggers: StructuredLogger[] = [];

function createLogger(...arguments_: ConstructorParameters<typeof StructuredLogger>) {
    const logger = new StructuredLogger(...arguments_);
    loggers.push(logger);
    return logger;
}

afterEach(async () => {
    // The fixture owns the logger; service shutdown alone does not drain its queued filesystem writes.
    await Promise.all(loggers.map((logger) => logger.flush()));
    loggers.length = 0;
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
            createLogger(join(directory, 'logs')),
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
        const logger = createLogger(join(directory, 'logs'));
        const service = new FileService(
            database,
            () => {},
            logger,
            () => 1024,
        );

        const listings = await Promise.all([service.list(session.id), service.list(session.id)]);
        expect(listings[0]).toEqual(listings[1]);
        await logger.flush();
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
        const canonicalRoot = await realpath(root);
        const watchedPath = join(root, 'watched.txt');
        await writeFile(watchedPath, 'before', 'utf8');
        const canonicalWatchedPath = await realpath(watchedPath);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        const gate = createEventGate<string>();
        const watchHub = createWatchDiagnosticHub();
        const service = new FileService(
            database,
            (event) => {
                if (event.event === 'files.changed')
                    for (const change of event.payload.changes) gate.push(change.path);
            },
            createLogger(join(directory, 'logs')),
            () => 1024,
            { pollIntervalMs: 50, watchHub },
        );
        try {
            await service.watchSession(session.id);
            const diagnose = createWatchFailureProbe(
                watchHub,
                'files-root',
                () => gate.events.length,
            );
            await writeFile(watchedPath, 'after', 'utf8');

            // A push-based wait for the first event settles the instant the watcher (native callback or fallback
            // poll) actually observes the write, instead of resampling `gate.events.length` on a fixed interval
            // that itself competes for the same event loop under CI load — see issue #1259.
            await diagnose(gate.waitFor(() => true));
            /**
             * Wait beyond a complete polling interval so the native event cannot be replayed as a phantom change.
             */
            await new Promise((resolve) => setTimeout(resolve, 150));
            /**
             * MacOS may report both the changed file and its parent directory in one native batch, especially under
             * parallel filesystem load. Coalescing guarantees one event per canonical path; it does not suppress a
             * valid parent-directory invalidation.
             */
            expect(gate.events.filter((path) => path === canonicalWatchedPath)).toEqual([
                canonicalWatchedPath,
            ]);
            expect(new Set(gate.events).size).toBe(gate.events.length);
            expect(
                gate.events.every(
                    (path) => path === canonicalRoot || path.startsWith(`${canonicalRoot}/`),
                ),
            ).toBe(true);
        } finally {
            await service.close();
            await watchHub.close();
            database.close();
        }
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
            createLogger(join(directory, 'logs')),
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
            createLogger(join(directory, 'logs')),
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
            createLogger(join(directory, 'logs')),
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

    it('resolves the replacement root while disposing the previous native watcher', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-watch-replace-'));
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
        const firstDisposal = Promise.withResolvers<void>();
        const firstUnsubscribe = vi.fn(() => firstDisposal.promise);
        const secondUnsubscribe = vi.fn(() => Promise.resolve());
        const subscribe = vi
            .fn()
            .mockResolvedValueOnce({ unsubscribe: firstUnsubscribe })
            .mockResolvedValueOnce({ unsubscribe: secondUnsubscribe });
        const service = new FileService(
            database,
            () => {},
            createLogger(join(directory, 'logs')),
            () => 1024,
            { subscribe },
        );
        await service.watchSession(first.id);
        const originalResolve = service.resolveSessionPath.bind(service);
        const secondResolution = Promise.withResolvers<void>();
        const secondResolveStarted = vi.fn();
        vi.spyOn(service, 'resolveSessionPath').mockImplementation(async (sessionId, input) => {
            if (input === undefined && sessionId === second.id) {
                secondResolveStarted();
                await secondResolution.promise;
            }
            return originalResolve(sessionId, input);
        });

        const replacement = service.watchSession(second.id);
        await vi.waitFor(() => expect(firstUnsubscribe).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(secondResolveStarted).toHaveBeenCalledOnce());
        secondResolution.resolve();
        await Promise.resolve();
        expect(subscribe).toHaveBeenCalledOnce();
        firstDisposal.resolve();
        await replacement;
        expect(subscribe).toHaveBeenCalledTimes(2);

        await service.close();
        expect(secondUnsubscribe).toHaveBeenCalledOnce();
        database.close();
    });

    it('reconciles once and stays native on a must-rescan FSEvents advisory, without falling back', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-watch-must-rescan-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        const events: ServerEvent[] = [];
        let callback: Parameters<typeof parcelWatcher.subscribe>[1] | undefined;
        let subscribeCalls = 0;
        const subscribe: typeof parcelWatcher.subscribe = (_root, onEvents) => {
            subscribeCalls += 1;
            callback = onEvents;
            return Promise.resolve({ unsubscribe: () => Promise.resolve() });
        };
        const onRootUnavailable = vi.fn();
        const logger = createLogger(join(directory, 'logs'));
        const service = new FileService(
            database,
            (event) => events.push(event),
            logger,
            () => 1024,
            { subscribe, onRootUnavailable },
        );

        await service.watchSession(session.id);
        expect(callback).toBeDefined();
        // FSEventsBackend.cc's MustScanSubDirs advisory: the native stream stays alive, so the callback fires again
        // with no events and this exact message (see `watch-hub.ts`'s `isMustRescanAdvisory`).
        callback!(
            new Error(
                'Events were dropped by the FSEvents client. File system must be re-scanned.',
            ),
            [],
        );

        await expect
            .poll(() => events.filter((event) => event.event === 'files.changed'))
            .toHaveLength(1);
        const batch = events.find((event) => event.event === 'files.changed')!;
        expect(batch.payload).toMatchObject({ changes: [], overflow: true });
        // Only the initial subscribe call: the advisory never degrades to polling, so no resubscribe attempt runs.
        expect(subscribeCalls).toBe(1);
        expect(onRootUnavailable).not.toHaveBeenCalled();

        await logger.flush();
        const records = (await readFile(logger.path, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { event: string });
        expect(records.some((record) => record.event === 'watch_hub.rescan')).toBe(true);
        expect(records.some((record) => record.event === 'watcher.fallback')).toBe(false);
        expect(records.some((record) => record.event === 'watch_hub.fallback')).toBe(false);

        await service.close();
        database.close();
    });
});
