import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { ProjectRootResolver } from '../../project-roots';
import { GitService } from '..';

const temporaryDirectories: string[] = [];
const gitServices: GitService[] = [];
const loggers: StructuredLogger[] = [];
const databases: CaxriDatabase[] = [];

/**
 * Services close before their directories are removed so an in-flight metadata-watcher subscription cannot race the
 * cleanup; loggers flush after their producers stop.
 */
afterEach(async () => {
    await Promise.allSettled(gitServices.map((service) => service.close()));
    gitServices.length = 0;
    for (const database of databases) database.close();
    databases.length = 0;
    await Promise.all(loggers.map((logger) => logger.flush()));
    loggers.length = 0;
    await Promise.all(
        temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })),
    );
    temporaryDirectories.length = 0;
});

async function summarize(directory: string) {
    const database = new CaxriDatabase(join(directory, '.caxri-test.db'));
    databases.push(database);
    const session = database.createSession(database.createProject(directory).id, 'shell').session;
    const logger = new StructuredLogger(join(directory, '.logs'));
    loggers.push(logger);
    const service = new GitService(new ProjectRootResolver(database), logger);
    gitServices.push(service);
    return service.summary(session.id);
}

async function createRepo(): Promise<(...arguments_: string[]) => Promise<unknown>> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-git-detached-'));
    temporaryDirectories.push(directory);
    const git = (...arguments_: string[]) => execFileAsync('git', arguments_, { cwd: directory });
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'caxri@example.invalid');
    await git('config', 'user.name', 'Caxri Test');
    await git('commit', '--allow-empty', '-m', 'pinned release');
    await git('tag', 'v1.0.0');
    await git('commit', '--allow-empty', '-m', 'later work');
    return git;
}

describe('GitService detached HEAD', () => {
    it('names a detached HEAD by the tag at that commit and its subject', async () => {
        const git = await createRepo();
        await git('checkout', '--detach', 'v1.0.0');
        const summary = await summarize(temporaryDirectories[0]);

        expect(summary.repositories[0]).toMatchObject({
            branch: '(detached)',
            detachedHead: { subject: 'pinned release', reference: 'v1.0.0' },
        });
        expect(summary.repositories[0].upstream).toBeUndefined();
    });

    it('falls back to the subject when nothing names the commit', async () => {
        const git = await createRepo();
        await git('checkout', '--detach', 'HEAD');
        const summary = await summarize(temporaryDirectories[0]);

        expect(summary.repositories[0].detachedHead).toEqual({ subject: 'later work' });
    });

    it('skips the extra reads for a branch checkout', async () => {
        await createRepo();
        const summary = await summarize(temporaryDirectories[0]);

        expect(summary.repositories[0].branch).toBe('main');
        expect(summary.repositories[0].detachedHead).toBeUndefined();
    });
});
