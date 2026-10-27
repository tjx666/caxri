import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { FileService } from '../service';

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
            createLogger(join(directory, 'logs')),
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
            ).resolves.toMatchObject({ workbenchRootProjectId: worktree.id });
        } finally {
            await service.close();
            database.close();
        }
    });
});
