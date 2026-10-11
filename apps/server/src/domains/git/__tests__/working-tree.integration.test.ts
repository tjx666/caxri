import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const databases: CaxriDatabase[] = [];

/**
 * Registers a GitService so afterEach can close it before the temp directories are removed; otherwise an in-flight
 * metadata-watcher subscription races directory cleanup and its fallback logging rejects with ENOENT after the logger's
 * directory is gone.
 */
function trackGitService(git: GitService): GitService {
    gitServices.push(git);
    return git;
}

afterEach(async () => {
    const servicesToClose = [...gitServices];
    gitServices.length = 0;
    await Promise.allSettled(servicesToClose.map((git) => git.close()));
    for (const database of databases) database.close();
    databases.length = 0;
    await flushLoggers();
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', arguments_, { cwd });
    return stdout;
}

async function createRepo(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    await git(directory, 'init', '-b', 'main');
    await git(directory, 'config', 'user.email', 'test@example.com');
    await git(directory, 'config', 'user.name', 'Caxri Test');
    return directory;
}

/**
 * The database and log directory live outside the repository: a discard-all runs `git clean -fd`, which would otherwise
 * delete the harness's own untracked support files mid-test.
 */
async function createService(directory: string): Promise<{ git: GitService; sessionId: string }> {
    const support = await mkdtemp(join(tmpdir(), 'caxri-git-support-'));
    temporaryDirectories.push(support);
    const database = new CaxriDatabase(join(support, 'caxri-test.db'));
    databases.push(database);
    const session = database.createSession(database.createProject(directory).id, 'shell').session;
    const paths = new ProjectRootResolver(database);
    const logger = createLogger(join(support, 'logs'));
    return { git: trackGitService(new GitService(paths, logger)), sessionId: session.id };
}

async function firstRepoId(service: GitService, sessionId: string): Promise<string> {
    const summary = await service.summary(sessionId);
    return summary.repositories[0].id;
}

async function confirmedDiscard(
    service: GitService,
    sessionId: string,
    repoId: string,
    scope: { kind: 'all' } | { kind: 'file'; path: string },
): Promise<void> {
    const preflight = await service.discardPreflight({ sessionId, repositoryId: repoId, scope });
    expect(preflight.status).toBe('ready');
    if (preflight.status !== 'ready') throw new Error('Expected a discard consent token');
    await service.discardApply({ token: preflight.token });
}

async function isPresent(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

describe('GitWorkingTreeService', () => {
    it('measures each changed file, counting untracked files from disk and folding renames', async () => {
        const directory = await createRepo('caxri-git-line-stats-');
        await writeFile(join(directory, 'tracked.txt'), 'one\ntwo\nthree\n', 'utf8');
        await writeFile(join(directory, 'original.txt'), 'content\n', 'utf8');
        await git(directory, 'add', '.');
        await git(directory, 'commit', '-m', 'initial');
        await writeFile(join(directory, 'tracked.txt'), 'one\n2\n', 'utf8');
        await git(directory, 'mv', 'original.txt', 'renamed.txt');
        await writeFile(join(directory, 'new.txt'), 'a\nb\nc\n', 'utf8');
        const { git: service, sessionId } = await createService(directory);

        const [repo] = (await service.summary(sessionId)).repositories;
        const stats = Object.fromEntries(
            repo.files.map((file) => [file.path, [file.additions, file.deletions]]),
        );
        expect(stats).toEqual({
            'tracked.txt': [1, 2],
            'renamed.txt': [1, 1],
            'new.txt': [3, 0],
        });
        // Repository totals keep measuring only the tracked diff.
        expect([repo.additions, repo.deletions]).toEqual([2, 3]);
    });

    it('discards a tracked modification back to the committed content', async () => {
        const directory = await createRepo('caxri-git-discard-');
        await writeFile(join(directory, 'tracked.txt'), 'before\n', 'utf8');
        await git(directory, 'add', 'tracked.txt');
        await git(directory, 'commit', '-m', 'initial');
        await writeFile(join(directory, 'tracked.txt'), 'after\n', 'utf8');
        const { git: service, sessionId } = await createService(directory);
        const repoId = await firstRepoId(service, sessionId);

        await confirmedDiscard(service, sessionId, repoId, {
            kind: 'file',
            path: 'tracked.txt',
        });

        await expect(readFile(join(directory, 'tracked.txt'), 'utf8')).resolves.toBe('before\n');
    });

    it('discards a staged modification, a deletion, and reports the tree clean afterwards', async () => {
        const directory = await createRepo('caxri-git-discard-');
        await writeFile(join(directory, 'staged.txt'), 'before\n', 'utf8');
        await writeFile(join(directory, 'removed.txt'), 'keep\n', 'utf8');
        await git(directory, 'add', '.');
        await git(directory, 'commit', '-m', 'initial');
        await writeFile(join(directory, 'staged.txt'), 'after\n', 'utf8');
        await git(directory, 'add', 'staged.txt');
        await rm(join(directory, 'removed.txt'));
        const { git: service, sessionId } = await createService(directory);
        const repoId = await firstRepoId(service, sessionId);

        await confirmedDiscard(service, sessionId, repoId, {
            kind: 'file',
            path: 'staged.txt',
        });
        await confirmedDiscard(service, sessionId, repoId, {
            kind: 'file',
            path: 'removed.txt',
        });

        await expect(readFile(join(directory, 'staged.txt'), 'utf8')).resolves.toBe('before\n');
        await expect(readFile(join(directory, 'removed.txt'), 'utf8')).resolves.toBe('keep\n');
        await expect(git(directory, 'status', '--porcelain')).resolves.toBe('');
    });

    it('deletes an untracked file and a staged addition on discard', async () => {
        const directory = await createRepo('caxri-git-discard-');
        await writeFile(join(directory, 'anchor.txt'), 'anchor\n', 'utf8');
        await git(directory, 'add', '.');
        await git(directory, 'commit', '-m', 'initial');
        await writeFile(join(directory, 'untracked.txt'), 'new\n', 'utf8');
        await writeFile(join(directory, 'added.txt'), 'new\n', 'utf8');
        await git(directory, 'add', 'added.txt');
        const { git: service, sessionId } = await createService(directory);
        const repoId = await firstRepoId(service, sessionId);

        await confirmedDiscard(service, sessionId, repoId, {
            kind: 'file',
            path: 'untracked.txt',
        });
        await confirmedDiscard(service, sessionId, repoId, {
            kind: 'file',
            path: 'added.txt',
        });

        await expect(isPresent(join(directory, 'untracked.txt'))).resolves.toBe(false);
        await expect(isPresent(join(directory, 'added.txt'))).resolves.toBe(false);
        await expect(git(directory, 'status', '--porcelain')).resolves.toBe('');
    });

    it('restores the original path and removes the new one when discarding a staged rename', async () => {
        const directory = await createRepo('caxri-git-discard-');
        await writeFile(join(directory, 'original.txt'), 'content\n', 'utf8');
        await git(directory, 'add', '.');
        await git(directory, 'commit', '-m', 'initial');
        await git(directory, 'mv', 'original.txt', 'renamed.txt');
        const { git: service, sessionId } = await createService(directory);
        const repoId = await firstRepoId(service, sessionId);
        const summary = await service.summary(sessionId);
        const renamed = summary.repositories[0].files.find((file) => file.kind === 'renamed');
        expect(renamed).toBeDefined();

        await confirmedDiscard(service, sessionId, repoId, {
            kind: 'file',
            path: renamed!.path,
        });

        await expect(readFile(join(directory, 'original.txt'), 'utf8')).resolves.toBe('content\n');
        await expect(isPresent(join(directory, 'renamed.txt'))).resolves.toBe(false);
        await expect(git(directory, 'status', '--porcelain')).resolves.toBe('');
    });

    it('treats discarding an already-clean path as a no-op', async () => {
        const directory = await createRepo('caxri-git-discard-');
        await writeFile(join(directory, 'tracked.txt'), 'content\n', 'utf8');
        await git(directory, 'add', '.');
        await git(directory, 'commit', '-m', 'initial');
        const { git: service, sessionId } = await createService(directory);
        const repoId = await firstRepoId(service, sessionId);

        await expect(
            service.discardPreflight({
                sessionId,
                repositoryId: repoId,
                scope: { kind: 'file', path: 'tracked.txt' },
            }),
        ).resolves.toEqual({ status: 'noop' });
    });

    it('discards every change at once, including untracked files', async () => {
        const directory = await createRepo('caxri-git-discard-all-');
        await writeFile(join(directory, 'tracked.txt'), 'before\n', 'utf8');
        await git(directory, 'add', '.');
        await git(directory, 'commit', '-m', 'initial');
        await writeFile(join(directory, 'tracked.txt'), 'after\n', 'utf8');
        await writeFile(join(directory, 'staged.txt'), 'staged\n', 'utf8');
        await git(directory, 'add', 'staged.txt');
        await writeFile(join(directory, 'untracked.txt'), 'new\n', 'utf8');
        const { git: service, sessionId } = await createService(directory);
        const repoId = await firstRepoId(service, sessionId);

        await confirmedDiscard(service, sessionId, repoId, { kind: 'all' });

        await expect(readFile(join(directory, 'tracked.txt'), 'utf8')).resolves.toBe('before\n');
        await expect(isPresent(join(directory, 'staged.txt'))).resolves.toBe(false);
        await expect(isPresent(join(directory, 'untracked.txt'))).resolves.toBe(false);
        await expect(git(directory, 'status', '--porcelain')).resolves.toBe('');
    });

    it('rejects a file consent when its tracked status changes to untracked before apply', async () => {
        const directory = await createRepo('caxri-git-discard-stale-');
        await writeFile(join(directory, 'tracked.txt'), 'before\n', 'utf8');
        await git(directory, 'add', 'tracked.txt');
        await git(directory, 'commit', '-m', 'initial');
        await writeFile(join(directory, 'tracked.txt'), 'modified\n', 'utf8');
        const { git: service, sessionId } = await createService(directory);
        const repoId = await firstRepoId(service, sessionId);
        const preflight = await service.discardPreflight({
            sessionId,
            repositoryId: repoId,
            scope: { kind: 'file', path: 'tracked.txt' },
        });
        expect(preflight.status).toBe('ready');
        if (preflight.status !== 'ready') throw new Error('Expected a discard consent token');

        await rm(join(directory, 'tracked.txt'));
        await writeFile(join(directory, 'tracked.txt'), 'new untracked content\n', 'utf8');
        await git(directory, 'rm', '--cached', '--quiet', 'tracked.txt');

        await expect(service.discardApply({ token: preflight.token })).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        await expect(readFile(join(directory, 'tracked.txt'), 'utf8')).resolves.toBe(
            'new untracked content\n',
        );
    });

    it('rejects a file consent when tracked content changes while its status kind stays modified', async () => {
        const directory = await createRepo('caxri-git-discard-content-');
        await writeFile(join(directory, 'tracked.txt'), 'before\n', 'utf8');
        await git(directory, 'add', 'tracked.txt');
        await git(directory, 'commit', '-m', 'initial');
        await writeFile(join(directory, 'tracked.txt'), 'first\n', 'utf8');
        const { git: service, sessionId } = await createService(directory);
        const repoId = await firstRepoId(service, sessionId);
        const preflight = await service.discardPreflight({
            sessionId,
            repositoryId: repoId,
            scope: { kind: 'file', path: 'tracked.txt' },
        });
        expect(preflight.status).toBe('ready');
        if (preflight.status !== 'ready') throw new Error('Expected a discard consent token');

        await writeFile(join(directory, 'tracked.txt'), 'second\n', 'utf8');

        await expect(service.discardApply({ token: preflight.token })).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        await expect(readFile(join(directory, 'tracked.txt'), 'utf8')).resolves.toBe('second\n');
    });

    it('rejects a file consent when an untracked path is replaced without changing its status', async () => {
        const directory = await createRepo('caxri-git-discard-untracked-content-');
        await writeFile(join(directory, 'anchor.txt'), 'anchor\n', 'utf8');
        await git(directory, 'add', 'anchor.txt');
        await git(directory, 'commit', '-m', 'initial');
        await writeFile(join(directory, 'untracked.txt'), 'first\n', 'utf8');
        const { git: service, sessionId } = await createService(directory);
        const repoId = await firstRepoId(service, sessionId);
        const preflight = await service.discardPreflight({
            sessionId,
            repositoryId: repoId,
            scope: { kind: 'file', path: 'untracked.txt' },
        });
        expect(preflight.status).toBe('ready');
        if (preflight.status !== 'ready') throw new Error('Expected a discard consent token');

        await rm(join(directory, 'untracked.txt'));
        await writeFile(join(directory, 'untracked.txt'), 'replacement\n', 'utf8');

        await expect(service.discardApply({ token: preflight.token })).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        await expect(readFile(join(directory, 'untracked.txt'), 'utf8')).resolves.toBe(
            'replacement\n',
        );
    });

    it('rejects an all-files consent when the working-tree count changes before apply', async () => {
        const directory = await createRepo('caxri-git-discard-stale-all-');
        await writeFile(join(directory, 'tracked.txt'), 'before\n', 'utf8');
        await git(directory, 'add', 'tracked.txt');
        await git(directory, 'commit', '-m', 'initial');
        await writeFile(join(directory, 'tracked.txt'), 'modified\n', 'utf8');
        const { git: service, sessionId } = await createService(directory);
        const repoId = await firstRepoId(service, sessionId);
        const preflight = await service.discardPreflight({
            sessionId,
            repositoryId: repoId,
            scope: { kind: 'all' },
        });
        expect(preflight.status).toBe('ready');
        if (preflight.status !== 'ready') throw new Error('Expected a discard consent token');

        await writeFile(join(directory, 'new.txt'), 'new\n', 'utf8');

        await expect(service.discardApply({ token: preflight.token })).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        await expect(readFile(join(directory, 'tracked.txt'), 'utf8')).resolves.toBe('modified\n');
        await expect(readFile(join(directory, 'new.txt'), 'utf8')).resolves.toBe('new\n');
    });

    it('consumes a discard consent token exactly once', async () => {
        const directory = await createRepo('caxri-git-discard-once-');
        await writeFile(join(directory, 'tracked.txt'), 'before\n', 'utf8');
        await git(directory, 'add', 'tracked.txt');
        await git(directory, 'commit', '-m', 'initial');
        await writeFile(join(directory, 'tracked.txt'), 'modified\n', 'utf8');
        const { git: service, sessionId } = await createService(directory);
        const repoId = await firstRepoId(service, sessionId);
        const preflight = await service.discardPreflight({
            sessionId,
            repositoryId: repoId,
            scope: { kind: 'file', path: 'tracked.txt' },
        });
        expect(preflight.status).toBe('ready');
        if (preflight.status !== 'ready') throw new Error('Expected a discard consent token');

        await expect(service.discardApply({ token: preflight.token })).resolves.toBeNull();
        await expect(service.discardApply({ token: preflight.token })).rejects.toMatchObject({
            code: 'CONFLICT',
        });
    });

    it('uses the complete status count when the public summary projection is truncated', async () => {
        const directory = await createRepo('caxri-git-discard-truncated-');
        await writeFile(join(directory, 'anchor.txt'), 'anchor\n', 'utf8');
        await git(directory, 'add', 'anchor.txt');
        await git(directory, 'commit', '-m', 'initial');
        await Promise.all(
            Array.from({ length: 2_001 }, (_unused, index) =>
                writeFile(join(directory, `untracked-${index}.txt`), `${index}\n`, 'utf8'),
            ),
        );
        const { git: service, sessionId } = await createService(directory);
        const repoId = await firstRepoId(service, sessionId);
        const summary = await service.summary(sessionId);
        expect(summary.repositories[0]?.truncated).toBe(true);

        const preflight = await service.discardPreflight({
            sessionId,
            repositoryId: repoId,
            scope: { kind: 'all' },
        });
        expect(preflight).toMatchObject({
            status: 'ready',
            scope: { kind: 'all', fileCount: 2_001 },
        });
        if (preflight.status !== 'ready') throw new Error('Expected a discard consent token');
        await expect(service.discardApply({ token: preflight.token })).resolves.toBeNull();
        await expect(git(directory, 'status', '--porcelain')).resolves.toBe('');
    });

    it('syncs by pulling remote commits and pushing local ones', async () => {
        const remote = await mkdtemp(join(tmpdir(), 'caxri-git-remote-'));
        temporaryDirectories.push(remote);
        await execFileAsync('git', ['init', '--bare', '-b', 'main'], { cwd: remote });

        const seed = await createRepo('caxri-git-seed-');
        await writeFile(join(seed, 'shared.txt'), 'base\n', 'utf8');
        await git(seed, 'add', '.');
        await git(seed, 'commit', '-m', 'base');
        await git(seed, 'remote', 'add', 'origin', remote);
        await git(seed, 'push', '-u', 'origin', 'main');

        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-sync-'));
        temporaryDirectories.push(directory);
        await execFileAsync('git', ['clone', remote, '.'], { cwd: directory });
        await git(directory, 'config', 'user.email', 'test@example.com');
        await git(directory, 'config', 'user.name', 'Caxri Test');
        // Git refuses a divergent pull without a reconcile strategy; merge mirrors VS Code's sync.
        await git(directory, 'config', 'pull.rebase', 'false');

        // One commit ahead locally, one behind from the seed checkout.
        await writeFile(join(directory, 'local.txt'), 'local\n', 'utf8');
        await git(directory, 'add', '.');
        await git(directory, 'commit', '-m', 'local work');
        await writeFile(join(seed, 'remote.txt'), 'remote\n', 'utf8');
        await git(seed, 'add', '.');
        await git(seed, 'commit', '-m', 'remote work');
        await git(seed, 'push');

        const { git: service, sessionId } = await createService(directory);
        const repoId = await firstRepoId(service, sessionId);

        await service.sync({ sessionId, repositoryId: repoId });

        await expect(readFile(join(directory, 'remote.txt'), 'utf8')).resolves.toBe('remote\n');
        const remoteLog = await git(remote, 'log', 'main', '--format=%s');
        expect(remoteLog).toContain('local work');
    });
});
