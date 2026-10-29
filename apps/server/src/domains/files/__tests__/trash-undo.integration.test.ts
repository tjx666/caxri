import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { StructuredLogger } from '@caxri/system';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { FileService } from '../service';

/**
 * Every Trash here lives inside the fixture directory (HOME and XDG_DATA_HOME are stubbed), so no run touches the
 * developer's own Trash.
 */
describe('FileService Trash Undo', () => {
    let directory: string;
    let database: CaxriDatabase;
    let logger: StructuredLogger;
    let root: string;
    let service: FileService;
    let sessionId: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'caxri-trash-undo-'));
        await mkdir(join(directory, 'project'));
        root = await realpath(join(directory, 'project'));
        vi.stubEnv('XDG_DATA_HOME', join(directory, 'data'));
        vi.stubEnv('HOME', directory);
        database = new CaxriDatabase(join(directory, 'state.db'));
        sessionId = database.createSession(database.createProject(root).id, 'shell').session.id;
        logger = new StructuredLogger(join(directory, 'logs'));
        service = new FileService(
            database,
            () => {},
            logger,
            () => 1024,
        );
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        await service.close();
        await logger.flush();
        database.close();
        await rm(directory, { force: true, recursive: true });
    });

    async function trash(path: string): Promise<string> {
        const approved = await service.authorizeTrash({ sessionId, path });
        const { undoToken } = await service.trashUndo.trashOnHost({ ...approved, sessionId, path });
        return undoToken;
    }

    it('puts a trashed file back at its original path', async () => {
        const target = join(root, 'notes.txt');
        await writeFile(target, 'keep me');
        const undoToken = await trash(target);
        await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });

        const restored = await service.trashUndo.restoreTrashed({ sessionId, undoToken });

        expect(restored).toEqual({ kind: 'file', name: 'notes.txt', path: target });
        expect(await readFile(target, 'utf8')).toBe('keep me');
    });

    it('puts a trashed folder back with its contents', async () => {
        const folder = join(root, 'docs');
        await mkdir(folder);
        await writeFile(join(folder, 'a.md'), 'nested');
        const undoToken = await trash(folder);

        const restored = await service.trashUndo.restoreTrashed({ sessionId, undoToken });

        expect(restored.kind).toBe('directory');
        expect(await readFile(join(folder, 'a.md'), 'utf8')).toBe('nested');
    });

    it('never overwrites a file that now occupies the original path, and keeps the Undo', async () => {
        const target = join(root, 'notes.txt');
        await writeFile(target, 'original');
        const undoToken = await trash(target);
        await writeFile(target, 'newer file');

        await expect(
            service.trashUndo.restoreTrashed({ sessionId, undoToken }),
        ).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        expect(await readFile(target, 'utf8')).toBe('newer file');

        await rm(target);
        await service.trashUndo.restoreTrashed({ sessionId, undoToken });
        expect(await readFile(target, 'utf8')).toBe('original');
    });

    it('never merges into a folder that now occupies the original path', async () => {
        const folder = join(root, 'docs');
        await mkdir(folder);
        await writeFile(join(folder, 'a.md'), 'old');
        const undoToken = await trash(folder);
        await mkdir(folder);

        await expect(
            service.trashUndo.restoreTrashed({ sessionId, undoToken }),
        ).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        await expect(stat(join(folder, 'a.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('consumes the Undo once it has restored the item', async () => {
        const target = join(root, 'once.txt');
        await writeFile(target, 'x');
        const undoToken = await trash(target);
        await service.trashUndo.restoreTrashed({ sessionId, undoToken });

        await expect(
            service.trashUndo.restoreTrashed({ sessionId, undoToken }),
        ).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });

    it("refuses an unknown token and another Session's token", async () => {
        const target = join(root, 'mine.txt');
        await writeFile(target, 'x');
        const undoToken = await trash(target);
        const other = database.createSession(
            database.createProject(await realpath(directory)).id,
            'shell',
        ).session.id;

        await expect(
            service.trashUndo.restoreTrashed({ sessionId, undoToken: 'missing' }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(
            service.trashUndo.restoreTrashed({ sessionId: other, undoToken }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('refuses when the folder it lived in is gone', async () => {
        const folder = join(root, 'parent');
        await mkdir(folder);
        const target = join(folder, 'child.txt');
        await writeFile(target, 'x');
        const undoToken = await trash(target);
        await rm(folder, { recursive: true });

        await expect(
            service.trashUndo.restoreTrashed({ sessionId, undoToken }),
        ).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });

    it('refuses when the Trash entry was emptied or replaced', async () => {
        const target = join(root, 'gone.txt');
        await writeFile(target, 'x');
        const undoToken = await trash(target);
        const trashed = join(directory, 'data', 'Trash', 'files', 'gone.txt');
        const macTrashed = join(directory, '.Trash', 'gone.txt');
        const entry = process.platform === 'darwin' ? macTrashed : trashed;
        await rm(entry);
        await writeFile(entry, 'someone else');

        await expect(
            service.trashUndo.restoreTrashed({ sessionId, undoToken }),
        ).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
        expect(await readFile(entry, 'utf8')).toBe('someone else');
        await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses to record a Trash move for a folder outside the Session root', async () => {
        await expect(
            service.trashUndo.recordTrash({
                sessionId,
                path: join(directory, 'x.txt'),
                trashPath: join(directory, 'x.txt'),
                device: '1',
                inode: '1',
            }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
    });

    describe('recordTrash for a location Main reports', () => {
        it('accepts a location whose entry has the approved identity', async () => {
            const target = join(root, 'native.txt');
            await writeFile(target, 'native');
            const approved = await service.authorizeTrash({ sessionId, path: target });
            const trashPath = join(directory, 'native-trash.txt');
            await rename(target, trashPath);

            const { undoToken } = await service.trashUndo.recordTrash({
                sessionId,
                path: approved.path,
                trashPath,
                device: approved.device,
                inode: approved.inode,
            });

            expect(undoToken).toEqual(expect.any(String));
            await service.trashUndo.restoreTrashed({ sessionId, undoToken: undoToken! });
            expect(await readFile(target, 'utf8')).toBe('native');
        });

        it('offers no Undo for a location holding a different item', async () => {
            const target = join(root, 'native.txt');
            await writeFile(target, 'native');
            const approved = await service.authorizeTrash({ sessionId, path: target });
            const other = join(directory, 'other.txt');
            await writeFile(other, 'unrelated');
            await rm(target);

            const { undoToken } = await service.trashUndo.recordTrash({
                sessionId,
                path: approved.path,
                trashPath: other,
                device: approved.device,
                inode: approved.inode,
            });

            expect(undoToken).toBeNull();
        });

        it('offers no Undo for a location that does not exist', async () => {
            const { undoToken } = await service.trashUndo.recordTrash({
                sessionId,
                path: join(root, 'x.txt'),
                trashPath: join(directory, 'missing'),
                device: '1',
                inode: '1',
            });

            expect(undoToken).toBeNull();
        });
    });
});
