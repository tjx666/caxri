import type { Dir } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_FILE_BROWSE_ENTRIES } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import {
    createSymlinkTargetProbe,
    ListingService,
    MAX_CONCURRENT_FILE_BROWSES,
    MAX_FILE_BROWSE_SCANNED_ENTRIES,
} from '../listing';
import { FileService } from '../service';
import { fakeDirent } from './listing-fixtures';

/**
 * `node:fs/promises` is a non-configurable ESM namespace, so `vi.spyOn` cannot patch `lstat` or `stat` directly, and a
 * module mock only applies to the file that declares it. `vi.hoisted` exposes settable overrides the mock factory reads
 * per call, letting one test prove browsing never restats an entry through its mutable path and another observe or
 * stall the single type-only follow a symlink entry makes through `stat`, while every other test keeps the real
 * filesystem behavior.
 */
const { setLstatOverride, getLstatOverride, setStatOverride, getStatOverride } = vi.hoisted(() => {
    type Override = ((path: string) => Promise<unknown> | undefined) | undefined;
    let lstatOverride: Override;
    let statOverride: Override;
    return {
        getLstatOverride: () => lstatOverride,
        getStatOverride: () => statOverride,
        setLstatOverride: (value: Override) => {
            lstatOverride = value;
        },
        setStatOverride: (value: Override) => {
            statOverride = value;
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
        stat: (path: Parameters<typeof actual.stat>[0], ...rest: unknown[]) => {
            const overridden = typeof path === 'string' ? getStatOverride()?.(path) : undefined;
            return (
                overridden ?? (actual.stat as (...arguments_: unknown[]) => unknown)(path, ...rest)
            );
        },
    };
});

const temporaryDirectories: string[] = [];
const loggers: StructuredLogger[] = [];
const services: FileService[] = [];

function createService(...arguments_: ConstructorParameters<typeof FileService>) {
    const service = new FileService(...arguments_);
    services.push(service);
    return service;
}

function createLogger(...arguments_: ConstructorParameters<typeof StructuredLogger>) {
    const logger = new StructuredLogger(...arguments_);
    loggers.push(logger);
    return logger;
}

afterEach(async () => {
    await Promise.all(services.map((service) => service.close()));
    services.length = 0;
    // The fixture owns the logger; service shutdown alone does not drain its queued filesystem writes.
    await Promise.all(loggers.map((logger) => logger.flush()));
    loggers.length = 0;
    const paths = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

describe('path browsing', () => {
    it('bounds path browsing while a name refinement can reach entries beyond the first page', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-browse-limit-'));
        temporaryDirectories.push(directory);
        await Promise.all(
            Array.from({ length: MAX_FILE_BROWSE_ENTRIES + 5 }, (_, index) =>
                writeFile(
                    join(directory, `file-${String(index).padStart(3, '0')}.txt`),
                    'x',
                    'utf8',
                ),
            ),
        );
        await writeFile(join(directory, 'zz-target.txt'), 'target', 'utf8');
        const targetPath = await realpath(join(directory, 'zz-target.txt'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const service = createService(
            database,
            () => {},
            createLogger(join(directory, 'logs')),
            () => 1024,
        );

        const initial = await service.browse({ sessionId: session.id, query: '' });
        expect(initial.entries).toHaveLength(MAX_FILE_BROWSE_ENTRIES);
        expect(initial.truncated).toBe(true);
        expect(initial.entries.some((entry) => entry.name === 'zz-target.txt')).toBe(false);

        await expect(service.browse({ sessionId: session.id, query: 'target' })).resolves.toEqual({
            entries: [
                {
                    kind: 'file',
                    name: 'zz-target.txt',
                    path: targetPath,
                },
            ],
            truncated: false,
        });
        database.close();
    });

    it('supersedes an older path refinement before continuing its directory scan', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-browse-refine-'));
        temporaryDirectories.push(directory);
        await Promise.all([
            writeFile(join(directory, 'first.txt'), 'first', 'utf8'),
            writeFile(join(directory, 'second.txt'), 'second', 'utf8'),
        ]);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const firstReadEntered = Promise.withResolvers<void>();
        const releaseFirstRead = Promise.withResolvers<void>();
        let openCount = 0;
        const openDirectory = vi.fn(() => {
            openCount += 1;
            const entries = [fakeDirent(openCount === 1 ? 'first.txt' : 'second.txt')];
            let index = 0;
            return Promise.resolve({
                close: () => Promise.resolve(),
                read: async () => {
                    if (openCount === 1 && index === 0) {
                        firstReadEntered.resolve();
                        await releaseFirstRead.promise;
                    }
                    return entries[index++] ?? null;
                },
            } as unknown as Dir);
        });
        const service = createService(
            database,
            () => {},
            createLogger(join(directory, 'logs')),
            () => 1024,
            { openDirectory },
        );

        const first = service.browse({ sessionId: session.id, query: 'first' });
        await firstReadEntered.promise;
        const second = service.browse({ sessionId: session.id, query: 'second' });
        await expect.poll(() => openDirectory.mock.calls.length).toBe(2);
        releaseFirstRead.resolve();

        await expect(first).resolves.toEqual({ entries: [], truncated: true });
        await expect(second).resolves.toMatchObject({
            entries: [{ name: 'second.txt' }],
            truncated: false,
        });
        database.close();
    });

    it('supersedes an older directory and bounds active browsing across Sessions', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-browse-concurrency-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const sessions = await Promise.all(
            Array.from({ length: MAX_CONCURRENT_FILE_BROWSES + 2 }, async (_, index) => {
                const root = join(directory, `project-${index}`);
                const nested = join(root, 'nested');
                await mkdir(nested, { recursive: true });
                return {
                    directory: nested,
                    session: database.createSession(database.createProject(root).id, 'shell')
                        .session,
                };
            }),
        );
        const releaseReads = Promise.withResolvers<void>();
        let active = 0;
        let maximumActive = 0;
        const openDirectory = vi.fn(() => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            let isRead = false;
            return Promise.resolve({
                close: () => {
                    active -= 1;
                    return Promise.resolve();
                },
                read: async () => {
                    if (isRead) return null;
                    isRead = true;
                    await releaseReads.promise;
                    return null;
                },
            } as unknown as Dir);
        });
        const service = createService(
            database,
            () => {},
            createLogger(join(directory, 'logs')),
            () => 1024,
            { openDirectory },
        );
        const previousDirectory = service.browse({
            sessionId: sessions[0].session.id,
            query: '',
        });
        await expect.poll(() => openDirectory.mock.calls.length).toBe(1);
        const requests = [
            previousDirectory,
            service.browse({
                sessionId: sessions[0].session.id,
                directory: sessions[0].directory,
                query: '',
            }),
            ...sessions
                .slice(1)
                .map(({ directory: path, session }) =>
                    service.browse({ sessionId: session.id, directory: path, query: '' }),
                ),
        ];
        await expect.poll(() => openDirectory.mock.calls.length).toBe(MAX_CONCURRENT_FILE_BROWSES);
        expect(maximumActive).toBe(MAX_CONCURRENT_FILE_BROWSES);
        releaseReads.resolve();
        await expect(previousDirectory).resolves.toEqual({ entries: [], truncated: true });
        await Promise.all(requests);
        expect(maximumActive).toBe(MAX_CONCURRENT_FILE_BROWSES);
        database.close();
    });

    it('caps a no-match path refinement and closes its directory handle', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-browse-scan-limit-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        let readCount = 0;
        const close = vi.fn(() => Promise.resolve());
        const service = createService(
            database,
            () => {},
            createLogger(join(directory, 'logs')),
            () => 1024,
            {
                openDirectory: () =>
                    Promise.resolve({
                        close,
                        read: () => {
                            readCount += 1;
                            return Promise.resolve(fakeDirent(`entry-${readCount}.txt`));
                        },
                    } as unknown as Dir),
            },
        );
        await expect(service.browse({ sessionId: session.id, query: 'absent' })).resolves.toEqual({
            entries: [],
            truncated: true,
        });
        expect(readCount).toBe(MAX_FILE_BROWSE_SCANNED_ENTRIES);
        expect(close).toHaveBeenCalledOnce();
        database.close();
    });

    it('describes a browse symlink by its target so a linked folder types and sorts as a folder', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-browse-symlink-'));
        temporaryDirectories.push(directory);
        await mkdir(join(directory, 'project'));
        const root = await realpath(join(directory, 'project'));
        await mkdir(join(root, 'real-dir'));
        await writeFile(join(root, 'real-file.ts'), '', 'utf8');
        await symlink('real-dir', join(root, 'link-to-dir'));
        await symlink('real-file.ts', join(root, 'link-to-file'));
        await symlink('./missing', join(root, 'broken-link'));
        const listing = new ListingService(
            () => Promise.resolve({ path: root, root }),
            createLogger(join(directory, 'logs')),
            () => ({}),
        );

        const { entries } = await listing.browse({ sessionId: 'session', query: '' });

        // Browse groups a linked directory with the directories now that it knows the target type, like the tree.
        expect(entries.map((entry) => entry.name)).toEqual([
            'link-to-dir',
            'real-dir',
            'broken-link',
            'link-to-file',
            'real-file.ts',
        ]);
        expect(entries.filter((entry) => entry.kind === 'symlink')).toEqual([
            {
                kind: 'symlink',
                linkKind: 'directory',
                linkTarget: 'real-dir',
                name: 'link-to-dir',
                path: join(root, 'link-to-dir'),
            },
            {
                kind: 'symlink',
                linkKind: 'broken',
                linkTarget: './missing',
                name: 'broken-link',
                path: join(root, 'broken-link'),
            },
            {
                kind: 'symlink',
                linkKind: 'file',
                linkTarget: 'real-file.ts',
                name: 'link-to-file',
                path: join(root, 'link-to-file'),
            },
        ]);
    });

    it('spends one type-only follow on a browse symlink and none on a regular entry', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-browse-follow-count-'));
        temporaryDirectories.push(directory);
        await mkdir(join(directory, 'project'));
        const root = await realpath(join(directory, 'project'));
        await mkdir(join(root, 'real-dir'));
        await writeFile(join(root, 'inside.txt'), 'inside', 'utf8');
        await symlink('real-dir', join(root, 'link-to-dir'));
        const filePath = join(root, 'inside.txt');
        const linkPath = join(root, 'link-to-dir');
        const listing = new ListingService(
            () => Promise.resolve({ path: root, root }),
            createLogger(join(directory, 'logs')),
            () => ({}),
        );
        const follows = new Map<string, number>();
        const restats = new Map<string, number>();
        setStatOverride((path) => {
            follows.set(path, (follows.get(path) ?? 0) + 1);
            return;
        });
        setLstatOverride((path) => {
            if (path === filePath || path === linkPath)
                restats.set(path, (restats.get(path) ?? 0) + 1);
            return;
        });

        try {
            const { entries } = await listing.browse({ sessionId: 'session', query: '' });

            expect(entries.map((entry) => entry.name)).toEqual([
                'link-to-dir',
                'real-dir',
                'inside.txt',
            ]);
            // The relaxation is exactly one type follow per symlink; nothing else leaves the opened directory.
            expect(follows.get(linkPath)).toBe(1);
            expect(follows.get(filePath)).toBeUndefined();
            expect(restats.size).toBe(0);
        } finally {
            setStatOverride(undefined);
            setLstatOverride(undefined);
        }
    });

    it('answers a browse whose symlink target hangs instead of waiting on the mount', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-browse-symlink-hang-'));
        temporaryDirectories.push(directory);
        await mkdir(join(directory, 'project'));
        const root = await realpath(join(directory, 'project'));
        await mkdir(join(root, 'real-dir'));
        await symlink('real-dir', join(root, 'link-to-dir'));
        const linkPath = join(root, 'link-to-dir');
        let createdProbes = 0;
        const logger = createLogger(join(directory, 'logs'));
        const write = vi.spyOn(logger, 'write');
        const listing = new ListingService(
            () => Promise.resolve({ path: root, root }),
            logger,
            () => ({}),
            undefined,
            undefined,
            undefined,
            undefined,
            {
                createSymlinkTargetProbe: (options) => {
                    createdProbes += 1;
                    return createSymlinkTargetProbe({ ...options, timeoutMs: 50 });
                },
            },
        );
        // A target on an unresponsive mount blocks `fs.stat` indefinitely and cannot be cancelled.
        setStatOverride((path) => (path === linkPath ? new Promise<never>(() => {}) : undefined));

        try {
            const { entries } = await listing.browse({ sessionId: 'session', query: 'link' });

            expect(entries).toMatchObject([{ kind: 'symlink', name: 'link-to-dir' }]);
            // The budget expired, so the row keeps the neutral icon rather than guessing a type.
            expect(entries[0]).not.toHaveProperty('linkKind');
            // One budget covers the whole browse, so a hung mount costs this listing a single timeout.
            expect(createdProbes).toBe(1);
            /**
             * An unprobed link is invisible in the result (it simply keeps the neutral icon), so without this record a
             * stale mount degrades the path browser with nothing to find afterwards. The reason separates a hung target
             * from a merely slow one, and the count is what turns one occurrence into a rate.
             */
            const budgetSpent = write.mock.calls.find(
                ([, event]) => event === 'file.symlink_probe_budget_spent',
            );

            expect(budgetSpent?.[2]?.fields).toMatchObject({
                path: '.',
                reason: 'probe_timeout',
                sessionId: 'session',
                spentCount: 1,
            });
        } finally {
            setStatOverride(undefined);
        }
    });

    it('uses opened-directory metadata without restatting entries through a mutable path', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-browse-dirent-'));
        temporaryDirectories.push(directory);
        await writeFile(join(directory, 'inside.txt'), 'inside', 'utf8');
        const entryPath = await realpath(join(directory, 'inside.txt'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const service = createService(
            database,
            () => {},
            createLogger(join(directory, 'logs')),
            () => 1024,
        );
        let entryRestats = 0;
        setLstatOverride((path) => {
            if (path === entryPath) entryRestats += 1;
            return;
        });

        try {
            await expect(
                service.browse({ sessionId: session.id, query: 'inside' }),
            ).resolves.toEqual({
                entries: [
                    {
                        kind: 'file',
                        name: 'inside.txt',
                        path: entryPath,
                    },
                ],
                truncated: false,
            });
            expect(entryRestats).toBe(0);
        } finally {
            setLstatOverride(undefined);
            database.close();
        }
    });
});
