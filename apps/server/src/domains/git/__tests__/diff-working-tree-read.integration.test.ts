import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { ProjectRootResolver } from '../../project/roots';
import { GitService } from '..';

const loggers: StructuredLogger[] = [];
const temporaryDirectories: string[] = [];
const gitServices: GitService[] = [];
const databases: CaxriDatabase[] = [];

function createLogger(...arguments_: ConstructorParameters<typeof StructuredLogger>) {
    const logger = new StructuredLogger(...arguments_);
    loggers.push(logger);
    return logger;
}

afterEach(async () => {
    const servicesToClose = [...gitServices];
    gitServices.length = 0;
    await Promise.allSettled(servicesToClose.map((git) => git.close()));
    for (const database of databases) database.close();
    databases.length = 0;
    const loggersToFlush = [...loggers];
    loggers.length = 0;
    await Promise.all(loggersToFlush.map((logger) => logger.flush()));
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('GitService working-tree document reads', () => {
    it('rejects a working-tree file whose first 8KiB contain a NUL byte', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-binary-diff-'));
        temporaryDirectories.push(directory);
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
            cwd: directory,
        });
        await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], { cwd: directory });
        await writeFile(join(directory, 'text.txt'), 'ok\n', 'utf8');
        await execFileAsync('git', ['add', 'text.txt'], { cwd: directory });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: directory });
        await writeFile(join(directory, 'text.txt'), 'changed\n', 'utf8');
        await writeFile(join(directory, 'binary.bin'), Buffer.from([0x68, 0x69, 0x00, 0x21]));

        const support = await mkdtemp(join(tmpdir(), 'caxri-git-binary-diff-support-'));
        temporaryDirectories.push(support);
        const database = new CaxriDatabase(join(support, 'caxri-test.db'));
        databases.push(database);
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const git = new GitService(
            new ProjectRootResolver(database),
            createLogger(join(support, 'logs')),
        );
        gitServices.push(git);
        const summary = await git.summary(session.id);

        await expect(
            git.diffDocument(session.id, summary.repositories[0].id, 'binary.bin'),
        ).rejects.toMatchObject({
            code: 'GIT',
        });
        await expect(
            git.diffDocument(session.id, summary.repositories[0].id, 'text.txt'),
        ).resolves.toMatchObject({ format: 'contents', path: 'text.txt', modified: 'changed\n' });
    });
});
