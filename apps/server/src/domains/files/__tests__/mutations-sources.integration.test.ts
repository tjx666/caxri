import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { FileService } from '../service';

interface Fixture {
    /**
     * A folder outside both Projects, standing in for Finder.
     */
    outside: string;
    service: FileService;
    source: { root: string; sessionId: string };
    target: { root: string; sessionId: string };
}

const cleanups: Array<() => Promise<void>> = [];

async function createFixture(): Promise<Fixture> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-file-sources-'));
    const directory = await realpath(temporary);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const logger = new StructuredLogger(join(directory, 'logs'));
    const service = new FileService(
        database,
        () => {},
        logger,
        () => 1024,
    );
    const project = async (name: string) => {
        const root = join(directory, name);
        await mkdir(root);
        const projectId = database.createProject(root).id;
        const sessionId = database.createSession(projectId, 'shell').session.id;
        return { root, sessionId };
    };
    const outside = join(directory, 'outside');
    await mkdir(outside);
    const [source, target] = await Promise.all([project('source'), project('target')]);
    cleanups.push(async () => {
        await service.close();
        await logger.flush();
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    return { outside, service, source, target };
}

afterEach(async () => {
    const pending = [...cleanups];
    cleanups.length = 0;
    await Promise.all(pending.map((cleanup) => cleanup()));
});

describe('FileService copy and move sources', () => {
    it('copies and moves an item from another Project into this one', async () => {
        const { service, source, target } = await createFixture();
        const note = join(source.root, 'note.txt');
        const folder = join(source.root, 'folder');
        await Promise.all([writeFile(note, 'note', 'utf8'), mkdir(folder)]);
        await writeFile(join(folder, 'nested.txt'), 'nested', 'utf8');

        const copied = await service.copy({
            sessionId: target.sessionId,
            path: note,
            directory: target.root,
            source: { kind: 'session', sessionId: source.sessionId },
        });
        expect(copied.path).toBe(join(target.root, 'note.txt'));
        await expect(readFile(copied.path, 'utf8')).resolves.toBe('note');
        await expect(readFile(note, 'utf8')).resolves.toBe('note');

        const moved = await service.move({
            sessionId: target.sessionId,
            path: folder,
            directory: target.root,
            conflict: 'reject',
            source: { kind: 'session', sessionId: source.sessionId },
        });
        expect(moved).toMatchObject({ path: join(target.root, 'folder'), previousPath: folder });
        await expect(readFile(join(moved.path, 'nested.txt'), 'utf8')).resolves.toBe('nested');
        await expect(access(folder)).rejects.toThrow();
    });

    it('still confines each path to its own Project root', async () => {
        const { outside, service, source, target } = await createFixture();
        const stray = join(outside, 'stray.txt');
        await writeFile(stray, 'stray', 'utf8');

        // A source named under another Session must still sit inside that Session's Project.
        await expect(
            service.move({
                sessionId: target.sessionId,
                path: stray,
                directory: target.root,
                conflict: 'reject',
                source: { kind: 'session', sessionId: source.sessionId },
            }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        // Without a source, a path in the other Project is outside this Session's root.
        await writeFile(join(source.root, 'note.txt'), 'note', 'utf8');
        await expect(
            service.copy({
                sessionId: target.sessionId,
                path: join(source.root, 'note.txt'),
                directory: target.root,
            }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        await expect(access(stray)).resolves.toBeUndefined();
    });

    it('copies a Finder item in without changing it, keeping both on a name clash', async () => {
        const { outside, service, target } = await createFixture();
        const dropped = join(outside, 'report.md');
        await Promise.all([
            writeFile(dropped, 'from finder', 'utf8'),
            writeFile(join(target.root, 'report.md'), 'existing', 'utf8'),
        ]);

        const imported = await service.copy({
            sessionId: target.sessionId,
            path: dropped,
            directory: target.root,
            source: { kind: 'external' },
        });
        expect(imported.name).toBe('report copy.md');
        await expect(readFile(imported.path, 'utf8')).resolves.toBe('from finder');
        await expect(readFile(dropped, 'utf8')).resolves.toBe('from finder');
        await expect(readFile(join(target.root, 'report.md'), 'utf8')).resolves.toBe('existing');
    });

    it('refuses a relative or symbolic-link external source', async () => {
        const { outside, service, target } = await createFixture();
        const link = join(outside, 'link');
        await writeFile(join(outside, 'real.txt'), 'real', 'utf8');
        await symlink(join(outside, 'real.txt'), link);

        await expect(
            service.copy({
                sessionId: target.sessionId,
                path: 'real.txt',
                directory: target.root,
                source: { kind: 'external' },
            }),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        await expect(
            service.copy({
                sessionId: target.sessionId,
                path: link,
                directory: target.root,
                source: { kind: 'external' },
            }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
    });
});
