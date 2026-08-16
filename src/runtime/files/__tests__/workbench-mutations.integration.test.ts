import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { StructuredLogger } from '../../../shared/node/logger';
import { CaxriDatabase } from '../../db/repository';
import { FileService } from '../service';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const paths = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

describe('FileService Workbench Root mutations', () => {
    it('captures the originating Workbench Project in a durable operation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-workbench-mutation-'));
        temporaryDirectories.push(directory);
        const ownerRoot = join(directory, 'owner');
        const worktreeRoot = join(directory, 'worktree');
        const destination = join(worktreeRoot, 'destination');
        await Promise.all([mkdir(ownerRoot), mkdir(destination, { recursive: true })]);
        const source = join(worktreeRoot, 'source.txt');
        await writeFile(source, 'source', 'utf8');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const owner = database.createProject(ownerRoot);
        const worktree = database.createProject(worktreeRoot);
        const created = database.createSession(owner.id, 'shell');
        const identity = await lstat(worktreeRoot, { bigint: true });
        database.selectWorkbenchProject(created.session.id, worktree.id, {
            device: identity.dev.toString(),
            inode: identity.ino.toString(),
        });
        const service = new FileService(
            database,
            () => {},
            new StructuredLogger(join(directory, 'logs')),
            () => 1024,
            { mutationJournalPath: join(directory, 'file-operations.json') },
        );
        await service.initialize();

        try {
            await service.move({
                conflict: 'reject',
                directory: destination,
                operationId: 'operation-workbench-root',
                path: source,
                sessionId: created.session.id,
            });

            await expect(
                service.getMutationOperation('operation-workbench-root'),
            ).resolves.toMatchObject({ workbenchProjectId: worktree.id });
        } finally {
            await service.close();
            database.close();
        }
    });
});
