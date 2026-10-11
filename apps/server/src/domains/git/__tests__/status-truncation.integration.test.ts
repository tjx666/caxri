import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_GIT_STATUS_FILES } from '@caxri/protocol';
import { execFileAsync, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { ProjectRootResolver } from '../../project/roots';
import { GitService } from '..';

const loggers: StructuredLogger[] = [];

function createLogger(...arguments_: ConstructorParameters<typeof StructuredLogger>) {
    const logger = new StructuredLogger(...arguments_);
    loggers.push(logger);
    return logger;
}

async function flushLoggers(): Promise<void> {
    const pendingLoggers = [...loggers];
    loggers.length = 0;
    await Promise.all(pendingLoggers.map((logger) => logger.flush()));
}
const temporaryDirectories: string[] = [];
const gitServices: GitService[] = [];

/**
 * Registers a GitService so afterEach can close it before the temp directories are removed; otherwise an in-flight
 * metadata-watcher subscription races directory cleanup and its fallback logging rejects with ENOENT after the logger's
 * directory is gone.
 */
function trackGitService(git: GitService): GitService {
    gitServices.push(git);
    return git;
}
/**
 * Batch size for writing the large untracked-file fixture so the event loop stays responsive.
 */
const UNTRACKED_FILE_WRITE_BATCH_SIZE = 200;

afterEach(async () => {
    const servicesToClose = [...gitServices];
    gitServices.length = 0;
    await Promise.allSettled(servicesToClose.map((git) => git.close()));
    await flushLoggers();
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

/**
 * Creates `count` empty untracked files named `untracked-<index>.txt` under `directory` using batched `Promise.all`
 * writes instead of one `git`/shell invocation per file.
 */
async function writeUntrackedFiles(directory: string, count: number): Promise<void> {
    const batchStarts = Array.from(
        { length: Math.ceil(count / UNTRACKED_FILE_WRITE_BATCH_SIZE) },
        (_, batchIndex) => batchIndex * UNTRACKED_FILE_WRITE_BATCH_SIZE,
    );
    for (const start of batchStarts) {
        const end = Math.min(start + UNTRACKED_FILE_WRITE_BATCH_SIZE, count);
        const batch = Array.from({ length: end - start }, (_, offset) => start + offset);
        // eslint-disable-next-line no-await-in-loop -- batches must be sequential to bound peak fd usage
        await Promise.all(
            batch.map((index) => writeFile(join(directory, `untracked-${index}.txt`), '', 'utf8')),
        );
    }
}

async function initRepo(directory: string): Promise<void> {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: directory });
    await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], { cwd: directory });
    await writeFile(join(directory, 'tracked.txt'), 'initial\n', 'utf8');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: directory });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: directory });
}

interface Fixture {
    /**
     * Git repository root; every untracked/tracked test file lives here so the status count stays exact.
     */
    repoDirectory: string;
    database: CaxriDatabase;
    git: GitService;
    sessionId: string;
}

/**
 * Keeps the CaxriDatabase file and StructuredLogger output outside the Git repository root so their on-disk artifacts
 * (`.caxri-test.db`, WAL/SHM siblings, `.logs`) never appear as untracked changes and skew the exact
 * `changedFileCount`/`files.length` assertions below.
 */
async function createFixture(): Promise<Fixture> {
    const parentDirectory = await mkdtemp(join(tmpdir(), 'caxri-git-status-'));
    temporaryDirectories.push(parentDirectory);
    const repoDirectory = join(parentDirectory, 'repo');
    const stateDirectory = join(parentDirectory, 'state');
    await Promise.all([mkdir(repoDirectory), mkdir(stateDirectory)]);
    await initRepo(repoDirectory);
    const database = new CaxriDatabase(join(stateDirectory, 'caxri-test.db'));
    const sessionId = database.createSession(database.createProject(repoDirectory).id, 'shell')
        .session.id;
    const rootResolver = new ProjectRootResolver(database);
    const gitLogger = createLogger(join(stateDirectory, 'logs'));
    const git = trackGitService(new GitService(rootResolver, gitLogger));
    return { repoDirectory, database, git, sessionId };
}

describe('GitRepoService status truncation', () => {
    it('bounds files[] at MAX_GIT_STATUS_FILES while reporting the pre-truncation total', async () => {
        const { repoDirectory, database, git, sessionId } = await createFixture();
        const extraFileCount = 50;
        await writeUntrackedFiles(repoDirectory, MAX_GIT_STATUS_FILES + extraFileCount);

        const summary = await git.summary(sessionId);
        const repo = summary.repositories[0];
        expect(repo.files).toHaveLength(MAX_GIT_STATUS_FILES);
        expect(repo.truncated).toBe(true);
        expect(repo.changedFileCount).toBe(MAX_GIT_STATUS_FILES + extraFileCount);

        const overview = await git.overview(sessionId);
        const overviewRepo = overview.repositories[0];
        expect(overviewRepo).not.toHaveProperty('files');
        expect(overviewRepo.truncated).toBe(true);
        expect(overviewRepo.changedFileCount).toBe(MAX_GIT_STATUS_FILES + extraFileCount);

        await git.close();
        database.close();
    });

    it('reports an untruncated summary for a small change set', async () => {
        const { repoDirectory, database, git, sessionId } = await createFixture();
        await Promise.all([
            writeFile(join(repoDirectory, 'small-1.txt'), '', 'utf8'),
            writeFile(join(repoDirectory, 'small-2.txt'), '', 'utf8'),
            writeFile(join(repoDirectory, 'small-3.txt'), '', 'utf8'),
        ]);

        const summary = await git.summary(sessionId);
        const repo = summary.repositories[0];
        expect(repo.truncated).toBe(false);
        expect(repo.changedFileCount).toBe(3);
        expect(repo.files).toHaveLength(3);

        await git.close();
        database.close();
    });

    it('advances the repository generation and picks up new changes on an explicit refresh nonce', async () => {
        const { repoDirectory, database, git, sessionId } = await createFixture();

        const firstSummary = await git.summary(sessionId);
        const secondSummary = await git.summary(sessionId);
        const firstRepo = firstSummary.repositories[0];
        const secondRepo = secondSummary.repositories[0];
        expect(secondRepo.generation).toBe(firstRepo.generation);

        await writeFile(join(repoDirectory, 'refreshed.txt'), '', 'utf8');
        const refreshedSummary = await git.summary(sessionId, 1);
        const refreshedRepo = refreshedSummary.repositories[0];
        expect(refreshedRepo.generation).toBeGreaterThan(firstRepo.generation);
        expect(refreshedRepo.files.map((file) => file.path)).toContain('refreshed.txt');

        await git.close();
        database.close();
    });
});
