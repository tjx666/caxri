import { execFile } from 'node:child_process';
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    realpath,
    lstat,
    rename,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relative } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { StructuredLogger } from '../../../shared/node/logger';
import { NativeFileOperations } from '../../../shared/node/native-file-operations';
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
const run = promisify(execFile);

async function createFixture(
    prefix: string,
    options?: (root: string) => FileServiceOptions,
): Promise<Fixture> {
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
        options?.(root),
    );
    const fixture = { database, directory, root, service, sessionId: session.id };
    fixtures.push(fixture);
    return fixture;
}

afterEach(async () => {
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

        const created = await service.create({ sessionId, directory: root, name: 'new.txt' });
        expect(created).toEqual({ kind: 'file', name: 'new.txt', path: join(root, 'new.txt') });
        await expect(readFile(created.path, 'utf8')).resolves.toBe('');

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
        });
        expect(movedFolder.path).toBe(join(destination, 'renamed-folder'));
        await expect(readFile(join(movedFolder.path, 'nested.txt'), 'utf8')).resolves.toBe(
            'nested',
        );

        await expect(
            service.authorizeTrash({ sessionId, path: join(movedFolder.path, 'nested.txt') }),
        ).resolves.toMatchObject({ kind: 'file', name: 'nested.txt' });
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

        await expect(
            service.create({ sessionId, directory: root, name: 'conflict.txt' }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(
            service.rename({ sessionId, path: source, name: 'conflict.txt' }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(readFile(source, 'utf8')).resolves.toBe('source');
        await expect(readFile(conflict, 'utf8')).resolves.toBe('keep me');

        await expect(
            service.move({ sessionId, path: root, directory: outside }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        await expect(
            service.move({ sessionId, path: folder, directory: child }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(
            service.move({ sessionId, path: source, directory: join(root, 'outside-link') }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        await expect(
            service.authorizeTrash({ sessionId, path: join(root, 'source-link') }),
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

    it('atomically rejects concurrent renames to the same destination without overwriting data', async () => {
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
        await expect(readdir(root)).resolves.not.toEqual(
            expect.arrayContaining([expect.stringMatching(/^\.caxri-file-op-/)]),
        );
    });

    it.skipIf(process.platform !== 'darwin')(
        'moves the authorized inode when the source pathname is replaced after binding',
        async () => {
            const { root } = await createFixture('caxri-file-source-race-');
            const source = join(root, 'source.txt');
            const held = join(root, 'held.txt');
            const target = join(root, 'target.txt');
            const ready = join(root, 'move-ready');
            const proceed = join(root, 'move-continue');
            await writeFile(source, 'authorized', 'utf8');
            const [rootStats, sourceStats] = await Promise.all([
                lstat(root, { bigint: true }),
                lstat(source, { bigint: true }),
            ]);

            const move = run('out/native/caxri-file-ops', [
                'move-test',
                root,
                rootStats.dev.toString(),
                rootStats.ino.toString(),
                relative(root, source),
                sourceStats.dev.toString(),
                sourceStats.ino.toString(),
                '.',
                rootStats.dev.toString(),
                rootStats.ino.toString(),
                'target.txt',
                ready,
                proceed,
            ]);
            await expect
                .poll(() =>
                    access(ready)
                        .then(() => true)
                        .catch(() => false),
                )
                .toBe(true);
            await rename(source, held);
            await writeFile(source, 'replacement', 'utf8');
            await writeFile(proceed, '', 'utf8');
            await move;

            await expect(readFile(target, 'utf8')).resolves.toBe('authorized');
            await expect(readFile(source, 'utf8')).resolves.toBe('replacement');
            await expect(access(held)).rejects.toThrow();
            await expect(readdir(root)).resolves.not.toEqual(
                expect.arrayContaining([expect.stringMatching(/^\.caxri-file-op-/)]),
            );
        },
    );

    it.skipIf(process.platform !== 'darwin')(
        'preserves every file visibly when source and target names are both reclaimed mid-move',
        async () => {
            const { root } = await createFixture('caxri-file-double-race-');
            const source = join(root, 'source.txt');
            const held = join(root, 'held.txt');
            const target = join(root, 'target.txt');
            const ready = join(root, 'move-ready');
            const proceed = join(root, 'move-continue');
            await writeFile(source, 'authorized', 'utf8');
            const [rootStats, sourceStats] = await Promise.all([
                lstat(root, { bigint: true }),
                lstat(source, { bigint: true }),
            ]);
            const move = run('out/native/caxri-file-ops', [
                'move-test',
                root,
                rootStats.dev.toString(),
                rootStats.ino.toString(),
                relative(root, source),
                sourceStats.dev.toString(),
                sourceStats.ino.toString(),
                '.',
                rootStats.dev.toString(),
                rootStats.ino.toString(),
                'target.txt',
                ready,
                proceed,
            ]);
            await expect
                .poll(() =>
                    access(ready)
                        .then(() => true)
                        .catch(() => false),
                )
                .toBe(true);
            await rename(source, held);
            await Promise.all([
                writeFile(source, 'source replacement', 'utf8'),
                writeFile(target, 'target replacement', 'utf8'),
            ]);
            await writeFile(proceed, '', 'utf8');

            const failure = await move.catch((error: unknown) => error as NodeJS.ErrnoException);
            expect(failure).toMatchObject({ code: 73 });
            const recoveryName = /RECOVERED:([^\r\n]+)/.exec(
                String((failure as NodeJS.ErrnoException & { stderr?: string }).stderr ?? ''),
            )?.[1];
            expect(recoveryName).toMatch(/^\.caxri-recovered-/);
            await expect(readFile(join(root, recoveryName!), 'utf8')).resolves.toBe('authorized');
            await expect(readFile(source, 'utf8')).resolves.toBe('source replacement');
            await expect(readFile(target, 'utf8')).resolves.toBe('target replacement');
            await expect(access(held)).rejects.toThrow();
            await expect(readdir(root)).resolves.not.toEqual(
                expect.arrayContaining([expect.stringMatching(/^\.caxri-file-op-/)]),
            );
        },
    );

    it('rejects a parent changed to a symlink after Runtime authorization', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-file-parent-race-outside-'));
        const outside = join(directory, 'outside');
        await mkdir(outside);
        const native = new NativeFileOperations('out/native/caxri-file-ops');
        const fixture = await createFixture('caxri-file-parent-race-', () => ({
            nativeFileOperations: {
                create: async (authorizedDirectory, name) => {
                    await rename(authorizedDirectory.path, `${authorizedDirectory.path}-moved`);
                    await symlink(outside, authorizedDirectory.path);
                    await native.create(authorizedDirectory, name);
                },
                move: (source, targetDirectory, name) => native.move(source, targetDirectory, name),
            },
        }));
        const targetDirectory = join(fixture.root, 'target');
        await mkdir(targetDirectory);

        await expect(
            fixture.service.create({
                sessionId: fixture.sessionId,
                directory: targetDirectory,
                name: 'escaped.txt',
            }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        await expect(access(join(outside, 'escaped.txt'))).rejects.toThrow();
        await rm(directory, { recursive: true, force: true });
    });

    it('rejects Trash when the authorized entry identity was replaced', async () => {
        const { root, service, sessionId } = await createFixture('caxri-trash-race-');
        const target = join(root, 'target.txt');
        const original = join(root, 'original.txt');
        await writeFile(target, 'original', 'utf8');
        const authorized = await service.authorizeTrash({ sessionId, path: target });
        await rename(target, original);
        await writeFile(target, 'replacement', 'utf8');

        const native = new NativeFileOperations('out/native/caxri-file-ops');
        await expect(native.trash(authorized, true)).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(readFile(target, 'utf8')).resolves.toBe('replacement');
        await expect(readFile(original, 'utf8')).resolves.toBe('original');
    });
});
