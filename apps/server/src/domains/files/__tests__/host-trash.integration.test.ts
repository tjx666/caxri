import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { StructuredLogger } from '@caxri/system';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { FileService } from '../service';

describe('FileService.trashOnHost', () => {
    let directory: string;
    let database: CaxriDatabase;
    let logger: StructuredLogger;
    let root: string;
    let service: FileService;
    let sessionId: string;

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'caxri-trash-on-host-'));
        await mkdir(join(directory, 'project'));
        root = await realpath(join(directory, 'project'));
        // Both roots of the host Trash point into the fixture, so no run touches the developer's own Trash.
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

    it('moves the approved entry into the host Trash', async () => {
        const target = join(root, 'agent-made.txt');
        await writeFile(target, 'created by an Agent');
        const approved = await service.authorizeTrash({ sessionId, path: target });

        await service.trashOnHost({ ...approved, sessionId, path: target });

        await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(
            await readFile(
                process.platform === 'darwin'
                    ? join(directory, '.Trash', 'agent-made.txt')
                    : join(directory, 'data', 'Trash', 'files', 'agent-made.txt'),
                'utf8',
            ),
        ).toBe('created by an Agent');
    });

    it('refuses a path replaced after the user approved it', async () => {
        const target = join(root, 'target.txt');
        await writeFile(target, 'original');
        const approved = await service.authorizeTrash({ sessionId, path: target });
        await rename(target, join(root, 'original.txt'));
        await writeFile(target, 'replacement');

        await expect(
            service.trashOnHost({ ...approved, sessionId, path: target }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await readFile(target, 'utf8')).toBe('replacement');
    });

    it('refuses the Project root and a path outside it', async () => {
        const outside = join(directory, 'outside.txt');
        await writeFile(outside, 'not in the Project');

        await expect(
            service.trashOnHost({ sessionId, path: root, device: '1', inode: '1' }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        await expect(
            service.trashOnHost({ sessionId, path: outside, device: '1', inode: '1' }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        await expect(access(outside)).resolves.toBeUndefined();
    });
});
