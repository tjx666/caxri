import { Buffer } from 'node:buffer';
import type { Dir, Dirent } from 'node:fs';
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

import { MAX_FILE_BROWSE_ENTRIES } from '../../../shared/ipc/methods';
import { StructuredLogger } from '../../../shared/node/logger';
import { CaxriDatabase } from '../../db/repository';
import {
    boundFileListEntries,
    MAX_CONCURRENT_FILE_BROWSES,
    MAX_FILE_BROWSE_SCANNED_ENTRIES,
    MAX_FILE_LIST_RESULT_BYTES,
} from '../listing';
import { FileService } from '../service';
import { didFingerprintChange, rememberPolledDirectory } from '../watcher';

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

function fakeDirent(name: string, kind: 'directory' | 'file' = 'file'): Dirent {
    return {
        isDirectory: () => kind === 'directory',
        isSymbolicLink: () => false,
        name,
    } as Dirent;
}

afterEach(async () => {
    const paths = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

describe('FileService', () => {
    it('keeps the serialized directory page below its transport byte budget', () => {
        const entries = Array.from({ length: 1_024 }, (_unused, index) => ({
            kind: 'file' as const,
            name: `entry-${index}.txt`,
            path: `/${'deep/'.repeat(700)}entry-${index}.txt`,
        }));

        const bounded = boundFileListEntries(entries);

        expect(bounded.length).toBeLessThan(entries.length);
        expect(
            Buffer.byteLength(JSON.stringify({ entries: bounded, truncated: true }), 'utf8'),
        ).toBeLessThanOrEqual(MAX_FILE_LIST_RESULT_BYTES);
    });

    it('bounds a directory page before it crosses the Files Core transport', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-files-list-bound-'));
        temporaryDirectories.push(directory);
        await Promise.all(
            Array.from({ length: 1_025 }, (_unused, index) =>
                writeFile(join(directory, `entry-${index.toString().padStart(4, '0')}.txt`), ''),
            ),
        );
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const service = new FileService(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
        ) as FileService & {
            listDirectory(sessionId: string): Promise<{
                entries: unknown[];
                truncated: boolean;
            }>;
        };

        const page = await service.listDirectory(session.id);

        expect(page.entries).toHaveLength(1_024);
        expect(page.truncated).toBe(true);
        await service.close();
        database.close();
    });

    it('stops scanning an oversized directory and closes its handle before building the page', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-files-list-scan-bound-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const maximumScannedEntries = 4_096;
        let readCount = 0;
        const close = vi.fn(() => Promise.resolve());
        const service = new FileService(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
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

        const page = await service.listDirectory(session.id);

        expect(page.entries).toEqual([]);
        expect(page.truncated).toBe(true);
        expect(readCount).toBe(maximumScannedEntries + 1);
        expect(close).toHaveBeenCalledOnce();
        await service.close();
        database.close();
    });

    it('keeps fallback polling bounded without evicting the active root', () => {
        const directories = new Map<string, string>();
        rememberPolledDirectory(directories, '/root', 'root', '/root', 3);
        rememberPolledDirectory(directories, '/root/a', 'a', '/root', 3);
        rememberPolledDirectory(directories, '/root/b', 'b', '/root', 3);
        rememberPolledDirectory(directories, '/root/c', 'c', '/root', 3);

        expect(directories.keys().toArray()).toEqual(['/root', '/root/b', '/root/c']);
    });

    it('deduplicates the same file version across native and polling backends', () => {
        const fingerprints = new Map<string, string>();

        expect(didFingerprintChange(fingerprints, '/root/file.ts', 'version-1', 3)).toBe(true);
        expect(didFingerprintChange(fingerprints, '/root/file.ts', 'version-1', 3)).toBe(false);
        expect(didFingerprintChange(fingerprints, '/root/file.ts', 'version-2', 3)).toBe(true);
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
            () => {},
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
            () => {},
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
            () => {},
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
            () => {},
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
        let isReplaced = false;
        const service = new FileService(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
            {
                openFile: async (path, flags, mode) => {
                    if (path === canonicalTarget && !isReplaced) {
                        isReplaced = true;
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
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
        );
        const resolvePath = service.resolveSessionPath.bind(service);
        vi.spyOn(service, 'resolveSessionPath').mockImplementationOnce(async (...arguments_) => {
            const resolved = await resolvePath(...arguments_);
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
            () => {},
            logger,
            () => 1024,
        );
        /**
         * Simulates a file that an AI agent deletes (ENOENT) or a file that briefly fails to stat mid-listing.
         */
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
            return;
        });

        try {
            const entries = await service.list(session.id);
            expect(entries.map((entry) => entry.name)).toEqual(['stays.txt']);
            await logger.flush();
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

    it('keeps dependency and build directories visible unless files.exclude hides them', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-tree-excludes-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await Promise.all([
            mkdir(join(root, '.git'), { recursive: true }),
            mkdir(join(root, 'dist'), { recursive: true }),
            mkdir(join(root, 'node_modules'), { recursive: true }),
        ]);
        await writeFile(join(root, 'visible.ts'), 'visible', 'utf8');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        let excludes: Record<string, boolean> = { '**/.git': true };
        const service = new FileService(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
            { fileTreeExcludes: () => excludes },
        );

        expect((await service.list(session.id)).map((entry) => entry.name)).toEqual([
            'dist',
            'node_modules',
            'visible.ts',
        ]);
        excludes = { '**/.git': false, '**/dist': true };
        expect((await service.list(session.id)).map((entry) => entry.name)).toEqual([
            '.git',
            'node_modules',
            'visible.ts',
        ]);
        database.close();
    });

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
        const service = new FileService(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
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
        const service = new FileService(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
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
        const service = new FileService(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
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
        const service = new FileService(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
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
        const service = new FileService(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
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
