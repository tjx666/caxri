import {
    access,
    chmod,
    link,
    mkdir,
    mkdtemp,
    open,
    readFile,
    realpath,
    rename,
    rm,
    symlink,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { StructuredLogger } from '../../../shared/node/logger';
import { CaxriDatabase } from '../../db/repository';
import { FileService, type FileServiceOptions } from '../service';

interface Fixture {
    database: CaxriDatabase;
    directory: string;
    root: string;
    service: FileService;
    sessionId: string;
}

const fixtures: Fixture[] = [];
async function createFixture(prefix: string, options: FileServiceOptions = {}): Promise<Fixture> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    const rootInput = join(directory, 'project');
    await mkdir(rootInput);
    const root = await realpath(rootInput);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const session = database.createSession(database.createProject(root).id, 'shell').session;
    const service = new FileService(
        database,
        () => undefined,
        new StructuredLogger(join(directory, 'logs')),
        () => 1024,
        options,
    );
    const fixture = { database, directory, root, service, sessionId: session.id };
    fixtures.push(fixture);
    return fixture;
}

afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
        fixtures.splice(0).map(async ({ database, directory, service }) => {
            await service.close();
            database.close();
            await rm(directory, { recursive: true, force: true });
        }),
    );
});

describe('FileMutationService', () => {
    it('creates, renames, and moves files and directories under the Project root', async () => {
        const { root, service, sessionId } = await createFixture('caxri-file-mutations-');
        const source = join(root, 'source.txt');
        const folder = join(root, 'folder');
        const destination = join(root, 'destination');
        await Promise.all([mkdir(folder), mkdir(destination), writeFile(source, 'source', 'utf8')]);
        await writeFile(join(folder, 'nested.txt'), 'nested', 'utf8');

        const created = await service.create({
            sessionId,
            directory: root,
            name: 'new.txt',
            kind: 'file',
        });
        expect(created).toEqual({ kind: 'file', name: 'new.txt', path: join(root, 'new.txt') });
        await expect(readFile(created.path, 'utf8')).resolves.toBe('');
        const createdDirectory = await service.create({
            sessionId,
            directory: root,
            name: 'new-folder',
            kind: 'directory',
        });
        expect(createdDirectory).toEqual({
            kind: 'directory',
            name: 'new-folder',
            path: join(root, 'new-folder'),
        });

        const renamedFile = await service.rename({
            sessionId,
            path: source,
            name: 'renamed.txt',
        });
        expect(renamedFile).toMatchObject({
            kind: 'file',
            name: 'renamed.txt',
            previousPath: source,
            path: join(root, 'renamed.txt'),
        });

        const renamedFolder = await service.rename({
            sessionId,
            path: folder,
            name: 'renamed-folder',
        });
        const movedFolder = await service.move({
            sessionId,
            path: renamedFolder.path,
            directory: destination,
            conflict: 'reject',
        });
        expect(movedFolder.path).toBe(join(destination, 'renamed-folder'));
        await expect(readFile(join(movedFolder.path, 'nested.txt'), 'utf8')).resolves.toBe(
            'nested',
        );

        await expect(
            service.authorizeTrash({ sessionId, path: join(movedFolder.path, 'nested.txt') }),
        ).resolves.toMatchObject({ kind: 'file', name: 'nested.txt' });
    });

    it('retains a completed mutation until its durable result is acknowledged', async () => {
        const { root, service, sessionId } = await createFixture('caxri-file-mutation-result-');
        const operationId = 'operation-durable-create';

        const result = await service.create({
            operationId,
            sessionId,
            directory: root,
            name: 'durable.txt',
            kind: 'file',
        });

        const operation = await service.getMutationOperation(operationId);
        expect(operation).toMatchObject({
            id: operationId,
            phase: 'completed',
            result,
        });
        if (operation?.kind !== 'create') throw new Error('Expected a durable create operation');
        expect(typeof operation.expectedResult?.device).toBe('string');
        expect(typeof operation.expectedResult?.inode).toBe('string');
        await service.acknowledgeMutationOperation(operationId);
        await expect(service.getMutationOperation(operationId)).resolves.toBeUndefined();
    });

    it('copies recursively and auto-renames copy and cut-paste conflicts', async () => {
        const { directory, root, service, sessionId } = await createFixture(
            'caxri-file-copy-conflicts-',
        );
        const file = join(root, 'note.txt');
        const folder = join(root, 'folder');
        const destination = join(root, 'destination');
        await Promise.all([writeFile(file, 'note', 'utf8'), mkdir(folder), mkdir(destination)]);
        await writeFile(join(folder, 'nested.txt'), 'nested', 'utf8');
        await Promise.all([chmod(folder, 0o555), chmod(join(folder, 'nested.txt'), 0o744)]);

        const copiedFile = await service.copy({ sessionId, path: file, directory: root });
        expect(copiedFile.name).toBe('note copy.txt');
        await expect(readFile(copiedFile.path, 'utf8')).resolves.toBe('note');
        const copiedFolder = await service.copy({ sessionId, path: folder, directory: root });
        expect(copiedFolder.name).toBe('folder copy');
        await expect(readFile(join(copiedFolder.path, 'nested.txt'), 'utf8')).resolves.toBe(
            'nested',
        );
        const copiedFolderMode = (await stat(copiedFolder.path)).mode & 0o777;
        const copiedFileMode = (await stat(join(copiedFolder.path, 'nested.txt'))).mode & 0o777;
        await Promise.all([chmod(folder, 0o755), chmod(copiedFolder.path, 0o755)]);
        expect(copiedFolderMode).toBe(0o555);
        expect(copiedFileMode).toBe(0o744);
        const copyLogs = (await readFile(join(directory, 'logs', 'runtime.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as unknown as Record<string, unknown>)
            .filter((record) => record.event === 'file.copied');
        expect(typeof copyLogs.at(-1)?.durationMs).toBe('number');
        expect(copyLogs.at(-1)?.fields).toMatchObject({ entryCount: 2, totalBytes: 6 });

        await writeFile(join(destination, 'note.txt'), 'existing', 'utf8');
        const moved = await service.move({
            sessionId,
            path: file,
            directory: destination,
            conflict: 'rename',
        });
        expect(moved.name).toBe('note copy.txt');
        await expect(readFile(moved.path, 'utf8')).resolves.toBe('note');
        await expect(access(file)).rejects.toThrow();

        await expect(
            service.copy({ sessionId, path: folder, directory: join(folder) }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('rejects conflicts, root changes, symlinks, escapes, and descendant moves', async () => {
        const { directory, root, service, sessionId } = await createFixture(
            'caxri-file-mutation-safety-',
        );
        const source = join(root, 'source.txt');
        const conflict = join(root, 'conflict.txt');
        const folder = join(root, 'folder');
        const child = join(folder, 'child');
        const outside = join(directory, 'outside');
        await Promise.all([
            writeFile(source, 'source', 'utf8'),
            writeFile(conflict, 'keep me', 'utf8'),
            mkdir(child, { recursive: true }),
            mkdir(outside),
        ]);
        await symlink(outside, join(root, 'outside-link'));
        await symlink(source, join(root, 'source-link'));
        await symlink(outside, join(folder, 'nested-link'));

        await expect(
            service.create({
                sessionId,
                directory: root,
                name: 'conflict.txt',
                kind: 'file',
            }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(
            service.rename({ sessionId, path: source, name: 'conflict.txt' }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(readFile(source, 'utf8')).resolves.toBe('source');
        await expect(readFile(conflict, 'utf8')).resolves.toBe('keep me');

        await expect(
            service.move({ sessionId, path: root, directory: outside, conflict: 'reject' }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        await expect(
            service.move({ sessionId, path: folder, directory: child, conflict: 'reject' }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(
            service.copy({ sessionId, path: folder, directory: root }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        await expect(
            service.move({
                sessionId,
                path: source,
                directory: join(root, 'outside-link'),
                conflict: 'reject',
            }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        await expect(
            service.authorizeTrash({ sessionId, path: join(root, 'source-link') }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        await expect(service.authorizeOpen({ sessionId, path: source })).resolves.toMatchObject({
            kind: 'file',
            path: source,
        });
        await expect(
            service.authorizeOpen({ sessionId, path: join(root, 'source-link') }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        await expect(service.authorizeTrash({ sessionId, path: outside })).rejects.toMatchObject({
            code: 'PATH_DENIED',
        });
    });

    it('returns an inode fingerprint so Main can reject a path replaced during confirmation', async () => {
        const { root, service, sessionId } = await createFixture('caxri-trash-fingerprint-');
        const target = join(root, 'target.txt');
        await writeFile(target, 'original', 'utf8');

        const before = await service.authorizeTrash({ sessionId, path: target });
        await rename(target, join(root, 'original.txt'));
        await writeFile(target, 'replacement', 'utf8');
        const after = await service.authorizeTrash({ sessionId, path: target });

        expect(after.path).toBe(before.path);
        expect({ device: after.device, inode: after.inode }).not.toEqual({
            device: before.device,
            inode: before.inode,
        });
        await expect(access(join(root, 'original.txt'))).resolves.toBeUndefined();
    });

    it('rejects concurrent renames to the same destination without overwriting data', async () => {
        const { root, service, sessionId } = await createFixture('caxri-file-rename-race-');
        const first = join(root, 'first.txt');
        const second = join(root, 'second.txt');
        const target = join(root, 'target.txt');
        await Promise.all([writeFile(first, 'first', 'utf8'), writeFile(second, 'second', 'utf8')]);

        const results = await Promise.allSettled([
            service.rename({ sessionId, path: first, name: 'target.txt' }),
            service.rename({ sessionId, path: second, name: 'target.txt' }),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
            { reason: { code: 'CONFLICT' } },
        ]);

        const targetContent = await readFile(target, 'utf8');
        const losingSource = targetContent === 'first' ? second : first;
        await expect(readFile(losingSource, 'utf8')).resolves.toBe(
            targetContent === 'first' ? 'second' : 'first',
        );
    });

    it('rejects Project-local hard links to files outside the Project, including nested copies', async () => {
        const { directory, root, service, sessionId } = await createFixture(
            'caxri-file-hard-link-safety-',
        );
        const outside = join(directory, 'outside.txt');
        const linkedFile = join(root, 'linked.txt');
        const linkedFolder = join(root, 'linked-folder');
        await Promise.all([writeFile(outside, 'secret', 'utf8'), mkdir(linkedFolder)]);
        await Promise.all([
            link(outside, linkedFile),
            link(outside, join(linkedFolder, 'nested.txt')),
        ]);

        await expect(
            service.copy({ sessionId, path: linkedFile, directory: root }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        await expect(
            service.copy({ sessionId, path: linkedFolder, directory: root }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        await expect(access(join(root, 'linked-folder copy'))).rejects.toThrow();
        await expect(readFile(outside, 'utf8')).resolves.toBe('secret');
    });

    it('revalidates a rename source after its staged record is durable', async () => {
        let source = '';
        let preserved = '';
        const fixture = await createFixture('caxri-file-staged-rename-race-', {
            mutations: {
                afterMutationStage: async () => {
                    await rename(source, preserved);
                    await writeFile(source, 'replacement', 'utf8');
                },
            },
        });
        source = join(fixture.root, 'source.txt');
        preserved = join(fixture.root, 'preserved.txt');
        const target = join(fixture.root, 'target.txt');
        await writeFile(source, 'original', 'utf8');

        await expect(
            fixture.service.rename({
                operationId: 'operation-staged-race',
                sessionId: fixture.sessionId,
                path: source,
                name: 'target.txt',
            }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(readFile(preserved, 'utf8')).resolves.toBe('original');
        await expect(readFile(source, 'utf8')).resolves.toBe('replacement');
        await expect(access(target)).rejects.toThrow();
    });

    it('bounds recursive copies by entry count, total bytes, and duration', async () => {
        const entryFixture = await createFixture('caxri-file-copy-entry-limit-', {
            mutations: { copyLimits: { maximumEntries: 1 } },
        });
        const entryFolder = join(entryFixture.root, 'folder');
        await mkdir(entryFolder);
        await writeFile(join(entryFolder, 'nested.txt'), 'nested', 'utf8');
        await expect(
            entryFixture.service.copy({
                sessionId: entryFixture.sessionId,
                path: entryFolder,
                directory: entryFixture.root,
            }),
        ).rejects.toMatchObject({ code: 'CAPACITY' });
        await expect(access(join(entryFixture.root, 'folder copy'))).rejects.toThrow();

        const byteFixture = await createFixture('caxri-file-copy-byte-limit-', {
            mutations: { copyLimits: { maximumBytes: 3 } },
        });
        const largeFile = join(byteFixture.root, 'large.txt');
        await writeFile(largeFile, 'large', 'utf8');
        await expect(
            byteFixture.service.copy({
                sessionId: byteFixture.sessionId,
                path: largeFile,
                directory: byteFixture.root,
            }),
        ).rejects.toMatchObject({ code: 'CAPACITY' });

        let time = 0;
        const timeFixture = await createFixture('caxri-file-copy-time-limit-', {
            mutations: {
                copyLimits: { maximumDurationMs: 1 },
                now: () => {
                    time += 2;
                    return time;
                },
            },
        });
        const timedFile = join(timeFixture.root, 'timed.txt');
        await writeFile(timedFile, 'timed', 'utf8');
        await expect(
            timeFixture.service.copy({
                sessionId: timeFixture.sessionId,
                path: timedFile,
                directory: timeFixture.root,
            }),
        ).rejects.toMatchObject({ code: 'TIMEOUT' });
    });

    it('bounds post-copy target validation concurrency', async () => {
        let activeValidations = 0;
        let maximumActiveValidations = 0;
        let markValidationPoolFull!: () => void;
        let releaseValidations!: () => void;
        const validationPoolFull = new Promise<void>((resolve) => {
            markValidationPoolFull = resolve;
        });
        const validationsReleased = new Promise<void>((resolve) => {
            releaseValidations = resolve;
        });
        const fixture = await createFixture('caxri-file-copy-validation-concurrency-', {
            mutations: {
                beforeCopyTargetValidation: async () => {
                    activeValidations += 1;
                    maximumActiveValidations = Math.max(
                        maximumActiveValidations,
                        activeValidations,
                    );
                    if (activeValidations === 32) markValidationPoolFull();
                    try {
                        await validationsReleased;
                    } finally {
                        activeValidations -= 1;
                    }
                },
            },
        });
        const source = join(fixture.root, 'folder');
        await mkdir(source);
        await Promise.all(
            Array.from({ length: 40 }, (_, index) =>
                writeFile(join(source, `file-${index}.txt`), 'copy', 'utf8'),
            ),
        );

        const copying = fixture.service.copy({
            sessionId: fixture.sessionId,
            path: source,
            directory: fixture.root,
        });
        await validationPoolFull;
        expect(maximumActiveValidations).toBe(32);
        releaseValidations();

        await expect(copying).resolves.toMatchObject({ name: 'folder copy' });
        expect(maximumActiveValidations).toBe(32);
    });

    it('drains active target validations and stops queued checks after failure', async () => {
        let startedValidations = 0;
        let markValidationPoolFull!: () => void;
        let releaseValidations!: () => void;
        const validationPoolFull = new Promise<void>((resolve) => {
            markValidationPoolFull = resolve;
        });
        const validationsReleased = new Promise<void>((resolve) => {
            releaseValidations = resolve;
        });
        const fixture = await createFixture('caxri-file-copy-validation-failure-', {
            mutations: {
                beforeCopyTargetValidation: async () => {
                    const validation = startedValidations;
                    startedValidations += 1;
                    if (startedValidations === 32) markValidationPoolFull();
                    if (validation === 0) throw new Error('validation failed');
                    await validationsReleased;
                },
            },
        });
        const source = join(fixture.root, 'folder');
        await mkdir(source);
        await Promise.all(
            Array.from({ length: 40 }, (_, index) =>
                writeFile(join(source, `file-${index}.txt`), 'copy', 'utf8'),
            ),
        );

        const copying = fixture.service.copy({
            sessionId: fixture.sessionId,
            path: source,
            directory: fixture.root,
        });
        let settled = false;
        void copying.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        await validationPoolFull;
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(startedValidations).toBe(32);
        expect(settled).toBe(false);
        releaseValidations();
        await expect(copying).rejects.toThrow('partial copy was kept');
        expect(startedValidations).toBe(32);
    });

    it('aborts a stalled file transfer without deleting its partial target by path', async () => {
        let markTransferStarted!: () => void;
        const transferStarted = new Promise<void>((resolve) => {
            markTransferStarted = resolve;
        });
        const fixture = await createFixture('caxri-file-copy-stalled-transfer-', {
            mutations: {
                copyFile: async (_source, target, options) => {
                    await target.writeFile('partial', 'utf8');
                    expect(options.signal).toBeDefined();
                    markTransferStarted();
                    await new Promise<void>((_resolve, reject) => {
                        options.signal?.addEventListener('abort', () => {
                            reject(
                                new Error('Transfer aborted', {
                                    cause: options.signal?.reason,
                                }),
                            );
                        });
                    });
                },
                copyLimits: { maximumDurationMs: 10 },
            },
        });
        const source = join(fixture.root, 'source.txt');
        const target = join(fixture.root, 'source copy.txt');
        await writeFile(source, 'source', 'utf8');
        vi.useFakeTimers();

        const copying = fixture.service.copy({
            sessionId: fixture.sessionId,
            path: source,
            directory: fixture.root,
        });
        await transferStarted;
        await vi.advanceTimersByTimeAsync(10);

        await expect(copying).rejects.toMatchObject({ code: 'TIMEOUT' });
        await expect(copying).rejects.toThrow('partial copy was kept');
        await expect(readFile(target, 'utf8')).resolves.toBe('partial');
    });

    it('preserves foreign descendants after an aborted directory copy', async () => {
        let markTransferStarted!: () => void;
        const transferStarted = new Promise<void>((resolve) => {
            markTransferStarted = resolve;
        });
        let foreignPath = '';
        const fixture = await createFixture('caxri-file-copy-foreign-cleanup-', {
            mutations: {
                copyFile: async (_source, target, options) => {
                    await target.writeFile('partial', 'utf8');
                    await writeFile(foreignPath, 'foreign', 'utf8');
                    markTransferStarted();
                    await new Promise<void>((_resolve, reject) => {
                        options.signal.addEventListener('abort', () => {
                            reject(new Error('Transfer aborted'));
                        });
                    });
                },
                copyLimits: { maximumDurationMs: 10 },
            },
        });
        const source = join(fixture.root, 'folder');
        const target = join(fixture.root, 'folder copy');
        foreignPath = join(target, 'foreign.txt');
        await mkdir(source);
        await writeFile(join(source, 'nested.txt'), 'source', 'utf8');
        vi.useFakeTimers();

        const copying = fixture.service.copy({
            sessionId: fixture.sessionId,
            path: source,
            directory: fixture.root,
        });
        await transferStarted;
        await vi.advanceTimersByTimeAsync(10);

        await expect(copying).rejects.toMatchObject({ code: 'TIMEOUT' });
        await expect(readFile(foreignPath, 'utf8')).resolves.toBe('foreign');
        await expect(readFile(join(target, 'nested.txt'), 'utf8')).resolves.toBe('partial');
    });

    it('rejects a copy whose created target is replaced during transfer', async () => {
        let targetPath = '';
        let movedTargetPath = '';
        const fixture = await createFixture('caxri-file-copy-target-replaced-', {
            mutations: {
                copyFile: async (_source, target) => {
                    await target.writeFile('copied', 'utf8');
                    await rename(targetPath, movedTargetPath);
                    await writeFile(targetPath, 'foreign', 'utf8');
                },
            },
        });
        const source = join(fixture.root, 'source.txt');
        targetPath = join(fixture.root, 'source copy.txt');
        movedTargetPath = join(fixture.root, 'moved-target.txt');
        await writeFile(source, 'source', 'utf8');

        await expect(
            fixture.service.copy({
                sessionId: fixture.sessionId,
                path: source,
                directory: fixture.root,
            }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(readFile(targetPath, 'utf8')).resolves.toBe('foreign');
        await expect(readFile(movedTargetPath, 'utf8')).resolves.toBe('copied');
    });

    it('rejects a Project root replaced with an outside symlink before mutation', async () => {
        const fixture = await createFixture('caxri-file-project-root-swap-');
        const originalRoot = `${fixture.root}-original`;
        const outside = join(fixture.directory, 'outside');
        await mkdir(join(outside, 'target'), { recursive: true });
        await rename(fixture.root, originalRoot);
        await symlink(outside, fixture.root);

        await expect(
            fixture.service.create({
                sessionId: fixture.sessionId,
                directory: join(fixture.root, 'target'),
                name: 'outside.txt',
                kind: 'file',
            }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        await expect(access(join(outside, 'outside.txt'))).rejects.toThrow();
    });

    it('revalidates the destination after source preflight before copying', async () => {
        let destination = '';
        let outside = '';
        let swapped = false;
        const fixture = await createFixture('caxri-file-copy-destination-race-', {
            mutations: {
                beforeCopyValidation: async () => {
                    if (swapped) return;
                    swapped = true;
                    await rename(destination, `${destination}-original`);
                    await symlink(outside, destination);
                },
            },
        });
        destination = join(fixture.root, 'destination');
        outside = join(fixture.directory, 'outside');
        const source = join(fixture.root, 'source.txt');
        await Promise.all([
            mkdir(destination),
            mkdir(outside),
            writeFile(source, 'source', 'utf8'),
        ]);

        await expect(
            fixture.service.copy({
                sessionId: fixture.sessionId,
                path: source,
                directory: destination,
            }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(access(join(outside, 'source.txt'))).rejects.toThrow();
    });

    it('keeps unrelated document I/O available while a copy is in progress', async () => {
        let markTransferStarted!: () => void;
        let releaseTransfer!: () => void;
        const transferStarted = new Promise<void>((resolve) => {
            markTransferStarted = resolve;
        });
        const transferReleased = new Promise<void>((resolve) => {
            releaseTransfer = resolve;
        });
        const fixture = await createFixture('caxri-file-copy-unrelated-io-', {
            mutations: {
                copyFile: async (source, target) => {
                    markTransferStarted();
                    await transferReleased;
                    await target.writeFile(await source.readFile());
                },
            },
        });
        const copiedSource = join(fixture.root, 'large.txt');
        const unrelated = join(fixture.root, 'notes.txt');
        await Promise.all([
            writeFile(copiedSource, 'copy me', 'utf8'),
            writeFile(unrelated, 'available', 'utf8'),
        ]);

        const copying = fixture.service.copy({
            sessionId: fixture.sessionId,
            path: copiedSource,
            directory: fixture.root,
        });
        await transferStarted;

        await expect(fixture.service.read(fixture.sessionId, unrelated)).resolves.toMatchObject({
            content: 'available',
        });
        releaseTransfer();
        await expect(copying).resolves.toMatchObject({ name: 'large copy.txt' });
    });

    it('finishes an in-flight document read before moving its path', async () => {
        let releaseOpen!: () => void;
        let signalOpen!: () => void;
        const openStarted = new Promise<void>((resolve) => {
            signalOpen = resolve;
        });
        const openReleased = new Promise<void>((resolve) => {
            releaseOpen = resolve;
        });
        const fixture = await createFixture('caxri-file-read-move-order-', {
            openFile: async (...arguments_) => {
                signalOpen();
                await openReleased;
                return open(...arguments_);
            },
        });
        const source = join(fixture.root, 'source.txt');
        await writeFile(source, 'source', 'utf8');

        const reading = fixture.service.read(fixture.sessionId, source);
        await openStarted;
        let moved = false;
        const moving = fixture.service
            .rename({ sessionId: fixture.sessionId, path: source, name: 'moved.txt' })
            .then((result) => {
                moved = true;
                return result;
            });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(moved).toBe(false);

        releaseOpen();
        await expect(reading).resolves.toMatchObject({ content: 'source', path: source });
        await expect(moving).resolves.toMatchObject({ path: join(fixture.root, 'moved.txt') });
    });
});
