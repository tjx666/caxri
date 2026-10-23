import { Buffer } from 'node:buffer';
import type { Dir } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    open,
    opendir,
    readFile,
    realpath,
    rename,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { ListingService } from '../listing';
import { FileService } from '../service';
import { didFingerprintChange, rememberPolledDirectory } from '../watch-bounded-maps';
import { fakeDirent } from './listing-fixtures';

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

describe('FileService', () => {
    it('keeps a child directory listed when its permissions change after opening the parent', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-files-list-child-mode-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const child = join(root, 'volatile');
        await mkdir(child, { recursive: true });
        const canonicalRoot = await realpath(root);
        const logger = createLogger(join(directory, 'logs'));
        const listing = new ListingService(
            () => Promise.resolve({ path: canonicalRoot, root: canonicalRoot }),
            logger,
            () => ({}),
            undefined,
            undefined,
            undefined,
            async (path) => {
                const handle = await opendir(path);
                await chmod(child, 0o000);
                return handle;
            },
        );

        try {
            const result = await listing.listDirectory('session');
            await logger.flush();
            const records = (await readFile(logger.path, 'utf8'))
                .trim()
                .split('\n')
                .map(
                    (line) =>
                        JSON.parse(line) as { event: string; fields?: Record<string, unknown> },
                );
            const listRecord = records.find((record) => record.event === 'file.list');
            const stats = await lstat(canonicalRoot);

            expect(result.entries.map((entry) => entry.name)).toEqual(['volatile']);
            expect(result.truncated).toBe(false);
            expect(listRecord?.fields).toMatchObject({
                path: '.',
                entryCount: 1,
                device: stats.dev,
                inode: stats.ino,
            });
        } finally {
            await chmod(child, 0o700);
        }
    });

    it('verifies a false root EOF and keeps the child visible with the resolved directory identity', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-files-list-false-eof-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await mkdir(join(root, 'volatile'), { recursive: true });
        const canonicalRoot = await realpath(root);
        const logger = createLogger(join(directory, 'logs'));
        let openCount = 0;
        const listing = new ListingService(
            () => Promise.resolve({ path: canonicalRoot, root: canonicalRoot }),
            logger,
            () => ({}),
            undefined,
            undefined,
            undefined,
            (path) => {
                openCount += 1;
                return openCount === 1
                    ? Promise.resolve({
                          close: () => Promise.resolve(),
                          read: () => Promise.resolve(null),
                      } as unknown as Dir)
                    : opendir(path);
            },
        );

        const result = await listing.listDirectory('session');
        await logger.flush();
        const records = (await readFile(logger.path, 'utf8'))
            .trim()
            .split('\n')
            .map(
                (line) =>
                    JSON.parse(line) as {
                        event: string;
                        fields?: Record<string, unknown>;
                    },
            );
        const listRecord = records.find((record) => record.event === 'file.list');
        const stats = await lstat(canonicalRoot);

        expect(openCount).toBe(2);
        expect(result.entries.map((entry) => entry.name)).toEqual(['volatile']);
        expect(listRecord?.fields).toMatchObject({
            path: '.',
            entryCount: 1,
            scannedEntries: 1,
            device: stats.dev,
            inode: stats.ino,
            initialScannedEntries: 0,
            verificationScannedEntries: 1,
        });
    });

    it('records the resolved directory identity when both root scans are empty', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-files-list-empty-root-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await mkdir(root);
        const canonicalRoot = await realpath(root);
        const logger = createLogger(join(directory, 'logs'));
        const listing = new ListingService(
            () => Promise.resolve({ path: canonicalRoot, root: canonicalRoot }),
            logger,
            () => ({}),
        );

        const result = await listing.listDirectory('session');
        await logger.flush();
        const records = (await readFile(logger.path, 'utf8'))
            .trim()
            .split('\n')
            .map(
                (line) =>
                    JSON.parse(line) as {
                        event: string;
                        fields?: Record<string, unknown>;
                    },
            );
        const listRecord = records.find((record) => record.event === 'file.list');
        const stats = await lstat(canonicalRoot);

        expect(result.entries).toEqual([]);
        expect(listRecord?.fields).toMatchObject({
            path: '.',
            entryCount: 0,
            scannedEntries: 0,
            device: stats.dev,
            inode: stats.ino,
            initialScannedEntries: 0,
            verificationScannedEntries: 0,
        });
    });

    it('cancels one directory-list waiter without aborting a joined request', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-files-list-cancel-'));
        temporaryDirectories.push(directory);
        const canonicalDirectory = await realpath(directory);
        const directoryHandle = Promise.withResolvers<Dir>();
        const directoryOpened = Promise.withResolvers<void>();
        const listing = new ListingService(
            () => Promise.resolve({ path: canonicalDirectory, root: canonicalDirectory }),
            createLogger(join(canonicalDirectory, 'logs')),
            () => ({}),
            undefined,
            undefined,
            undefined,
            () => {
                directoryOpened.resolve();
                return directoryHandle.promise;
            },
        );
        const controller = new AbortController();
        const canceled = listing.listDirectory('session', undefined, controller.signal);
        const joined = listing.listDirectory('session');

        await directoryOpened.promise;
        controller.abort();
        directoryHandle.resolve({
            close: () => Promise.resolve(),
            read: () => Promise.resolve(null),
        } as unknown as Dir);
        const [canceledResult, joinedResult] = await Promise.allSettled([canceled, joined]);

        expect(canceledResult).toMatchObject({
            status: 'rejected',
            reason: { code: 'CANCELLED' },
        });
        expect(joinedResult).toEqual({
            status: 'fulfilled',
            value: { entries: [], truncated: false },
        });
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
            createLogger(join(directory, 'logs')),
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

        const page = await service.listDirectory(session.id);

        expect(page.entries).toEqual([]);
        expect(page.truncated).toBe(true);
        expect(readCount).toBe(maximumScannedEntries + 1);
        expect(close).toHaveBeenCalledOnce();
        await service.close();
        database.close();
    });

    it('describes a symlink by its target so a linked folder reads and sorts as a folder', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-files-symlink-'));
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

        const { entries } = await listing.listDirectory('session');

        // A linked directory joins the directory group; links to a file, and dangling links, stay with the files.
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

    it('reads and saves workspace links while rejecting direct outside paths', async () => {
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
            createLogger(join(directory, 'logs')),
            () => 1024,
        );
        expect((await service.read(session.id, join(root, 'hello.txt'))).content).toBe('hello');
        expect((await service.write(session.id, join(root, 'hello.txt'), 'updated')).content).toBe(
            'updated',
        );
        await expect(service.read(session.id, outside)).rejects.toThrow('outside');
        const canonicalRoot = await realpath(root);
        const alias = join(canonicalRoot, 'escape.txt');
        expect(await service.authorizeOpen({ sessionId: session.id, path: alias })).toMatchObject({
            path: alias,
            name: 'escape.txt',
            kind: 'file',
            root: { path: canonicalRoot },
        });
        expect(await service.read(session.id, alias)).toMatchObject({
            path: alias,
            content: 'secret',
        });
        expect(await service.write(session.id, alias, 'linked update')).toMatchObject({
            path: alias,
            content: 'linked update',
        });
        expect((await lstat(alias)).isSymbolicLink()).toBe(true);
        expect(await readFile(outside, 'utf8')).toBe('linked update');
        await symlink(directory, join(root, 'linked-directory'));
        const child = join(canonicalRoot, 'linked-directory', 'outside.txt');
        expect(
            await service.browse({
                sessionId: session.id,
                directory: join(canonicalRoot, 'linked-directory'),
                query: 'outside',
            }),
        ).toMatchObject({
            entries: [expect.objectContaining({ path: child })],
        });
        expect(
            await service.list(session.id, join(canonicalRoot, 'linked-directory')),
        ).toContainEqual(expect.objectContaining({ path: child, name: 'outside.txt' }));
        expect(await service.read(session.id, child)).toMatchObject({
            path: child,
            content: 'linked update',
        });
        expect(await service.write(session.id, child, 'nested update')).toMatchObject({
            path: child,
            content: 'nested update',
        });
        await expect(service.read(session.id, '../outside.txt')).rejects.toThrow('outside');
        await symlink('missing-target', join(root, 'broken-link'));
        await expect(service.read(session.id, join(root, 'broken-link'))).rejects.toThrow();
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
            createLogger(join(directory, 'logs')),
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
            createLogger(join(directory, 'logs')),
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
            createLogger(join(directory, 'logs')),
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
            createLogger(join(directory, 'logs')),
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
            createLogger(join(directory, 'logs')),
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
        const logger = createLogger(join(directory, 'logs'));
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
            createLogger(join(directory, 'logs')),
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
});
