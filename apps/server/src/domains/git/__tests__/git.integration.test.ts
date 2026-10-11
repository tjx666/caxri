import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { ServerEvent } from '@caxri/protocol';
import { execFileAsync, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { ExternalStatusHub } from '../../external-status';
import { ProjectRootResolver } from '../../project/roots';
import { GitService } from '..';
import type { GitMetadataWatcher } from '../metadata-watcher';
import { computeRepoId } from '../repo';

const temporaryDirectories: string[] = [];
const gitServices: GitService[] = [];
const loggers: StructuredLogger[] = [];

function createLogger(...arguments_: ConstructorParameters<typeof StructuredLogger>) {
    const logger = new StructuredLogger(...arguments_);
    loggers.push(logger);
    return logger;
}

interface GitServiceInternals {
    logger: StructuredLogger;
    metadataWatcher: GitMetadataWatcher;
    repositoryService: {
        childCache: Map<string, unknown>;
        sessionGenerations: Map<string, number>;
        statuses: { snapshots: Map<string, unknown> };
    };
}

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
    /**
     * Closing services queues final metrics; drain their logs after their producers stop, before queued writes can race
     * directory removal.
     */
    const loggersToFlush = [...loggers];
    loggers.length = 0;
    await Promise.all(loggersToFlush.map((logger) => logger.flush()));
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('GitService', () => {
    it('derives GitHub reference context and resolves commit hashes inside the Session scope', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-reference-'));
        temporaryDirectories.push(directory);
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
            cwd: directory,
        });
        await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], { cwd: directory });
        await writeFile(join(directory, 'reference.txt'), 'reference\n', 'utf8');
        await execFileAsync('git', ['add', 'reference.txt'], { cwd: directory });
        await execFileAsync('git', ['commit', '-m', 'reference commit'], { cwd: directory });
        await execFileAsync('git', ['remote', 'add', 'origin', 'git@github.com:tjx666/caxri.git'], {
            cwd: directory,
        });
        const sha = (
            await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: directory })
        ).stdout.trim();
        const database = new CaxriDatabase(join(directory, '.caxri-test.db'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const rootResolver = new ProjectRootResolver(database);
        const gitLogger = createLogger(join(directory, '.logs'));
        const git = trackGitService(new GitService(rootResolver, gitLogger));

        await expect(git.referenceContext(session.id)).resolves.toEqual({
            githubRepositories: [{ owner: 'tjx666', repo: 'caxri' }],
        });
        await expect(
            git.resolveCommitReference(session.id, sha.slice(0, 8), directory),
        ).resolves.toMatchObject({
            status: 'resolved',
            candidate: { sha },
        });
        await expect(
            git.resolveCommitReference(session.id, 'abcdef0', directory),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });

        await execFileAsync(
            'git',
            ['remote', 'set-url', 'origin', 'https://github.com/example/lobe-chat.git'],
            { cwd: directory },
        );
        await expect(git.referenceContext(session.id)).resolves.toEqual({
            githubRepositories: [{ owner: 'example', repo: 'lobe-chat' }],
        });
        database.close();
    });

    it('returns blame metadata for the selected file line', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-blame-'));
        temporaryDirectories.push(directory);
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
            cwd: directory,
        });
        await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], { cwd: directory });
        const path = join(directory, 'source.ts');
        await writeFile(path, 'const first = 1;\nconst second = 2;\n', 'utf8');
        await execFileAsync('git', ['add', 'source.ts'], { cwd: directory });
        await execFileAsync('git', ['commit', '-m', 'add source'], { cwd: directory });
        const database = new CaxriDatabase(join(directory, '.caxri-test.db'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const rootResolver = new ProjectRootResolver(database);
        const gitLogger = createLogger(join(directory, '.logs'));
        const git = trackGitService(new GitService(rootResolver, gitLogger));

        await expect(git.blame({ sessionId: session.id, path, line: 2 })).resolves.toMatchObject({
            author: 'Caxri Test',
            line: 2,
            subject: 'add source',
            uncommitted: false,
        });
        await rm(path);
        await expect(git.blame({ sessionId: session.id, path, line: 2 })).resolves.toBeNull();
        const outside = await mkdtemp(join(tmpdir(), 'caxri-git-blame-linked-'));
        temporaryDirectories.push(outside);
        await writeFile(join(outside, 'linked.ts'), 'fixture');
        await symlink(join(outside, 'linked.ts'), path);
        await expect(git.blame({ sessionId: session.id, path, line: 2 })).resolves.toBeNull();
        database.close();
    });

    it('reports read-only status and selected-file diff', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-'));
        temporaryDirectories.push(directory);
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
            cwd: directory,
        });
        await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], { cwd: directory });
        await writeFile(join(directory, 'tracked.txt'), 'before\n', 'utf8');
        await execFileAsync('git', ['add', 'tracked.txt'], { cwd: directory });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: directory });
        await writeFile(join(directory, 'tracked.txt'), 'after\n', 'utf8');
        await execFileAsync('git', ['add', 'tracked.txt'], { cwd: directory });
        await writeFile(join(directory, 'new.txt'), 'new\n', 'utf8');
        const database = new CaxriDatabase(join(directory, '.caxri-test.db'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const logger = createLogger(join(directory, '.logs'));
        const paths = new ProjectRootResolver(database);
        const git = trackGitService(new GitService(paths, logger));
        const [summary, concurrentSummary] = await Promise.all([
            git.summary(session.id),
            git.summary(session.id),
        ]);
        expect(summary.isRepository).toBe(true);
        expect(concurrentSummary).toEqual(summary);
        expect(summary.repositories[0].branch).toBe('main');
        // Full 40-hex oid, not a shortened one: `git.commitDetails` params validate against it
        // when the Git panel's commit mode loads the last commit's changes from this head.
        expect(summary.repositories[0].head).toMatch(/^[0-9a-f]{40}$/);
        expect(summary.repositories[0]).toMatchObject({ additions: 1, deletions: 1 });
        expect(summary.repositories[0].files.map((file) => file.path)).toEqual(
            expect.arrayContaining(['tracked.txt', 'new.txt']),
        );
        await logger.flush();
        const records = (await readFile(logger.path, 'utf8'))
            .trim()
            .split('\n')
            .map(
                (line) =>
                    JSON.parse(line) as {
                        event: string;
                        durationMs?: number;
                        fields?: { operation?: string };
                    },
            );
        const statusRecords = records.filter(
            (record) => record.event === 'git.command' && record.fields?.operation === 'status',
        );
        expect(statusRecords).toHaveLength(1);
        expect(statusRecords[0].durationMs).toBeTypeOf('number');
        await expect(
            git.diffDocument(
                session.id,
                summary.repositories[0].id,
                join(directory, 'tracked.txt'),
            ),
        ).resolves.toEqual({
            format: 'contents',
            path: 'tracked.txt',
            original: 'before\n',
            modified: 'after\n',
        });
        await expect(
            git.diffDocument(session.id, summary.repositories[0].id, 'new.txt'),
        ).resolves.toEqual({
            format: 'contents',
            path: 'new.txt',
            original: '',
            modified: 'new\n',
        });
        await execFileAsync('git', ['restore', '--staged', '--worktree', 'tracked.txt'], {
            cwd: directory,
        });
        await git.summary(session.id, 1);
        await expect(
            git.diffDocument(session.id, summary.repositories[0].id, 'tracked.txt'),
        ).resolves.toBeNull();
        database.close();
    });

    it('does not restore an evicted Session projection when an older summary finishes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-eviction-'));
        temporaryDirectories.push(directory);
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
            cwd: directory,
        });
        await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], { cwd: directory });
        await writeFile(join(directory, 'tracked.txt'), 'initial\n', 'utf8');
        await execFileAsync('git', ['add', 'tracked.txt'], { cwd: directory });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: directory });

        const database = new CaxriDatabase(join(directory, '.caxri-test.db'));
        const project = database.createProject(directory);
        const session = database.createSession(project.id, 'shell').session;
        const sibling = database.createSession(project.id, 'shell').session;
        const resolutionStarted = Promise.withResolvers<void>();
        const releaseResolution = Promise.withResolvers<void>();
        let shouldBlock = false;
        const paths = new ProjectRootResolver(database, {
            beforeRootRealpath: async () => {
                if (!shouldBlock) return;
                shouldBlock = false;
                resolutionStarted.resolve();
                await releaseResolution.promise;
            },
        });
        const events: ServerEvent[] = [];
        const logger = createLogger(join(directory, '.logs'));
        const service = new GitService(paths, logger, {
            emit: (event) => events.push(event),
        });
        const git = trackGitService(service);

        await git.summary(sibling.id);
        const internals = service as unknown as GitServiceInternals;
        const watch = vi.spyOn(internals.metadataWatcher, 'watch');
        shouldBlock = true;
        const staleSummary = git.summary(session.id);
        await resolutionStarted.promise;
        git.evictSessions([session.id]);
        releaseResolution.resolve();
        await staleSummary;
        git.observeFilesChanged({ sessionId: session.id, changes: [{ path: 'tracked.txt' }] });

        expect(events).toEqual([]);
        expect(watch).not.toHaveBeenCalled();
        expect(internals.repositoryService.statuses.snapshots.size).toBe(1);
        expect(internals.repositoryService.childCache.size).toBe(1);

        const replacement = database.createSession(project.id, 'shell').session;
        await git.summary(replacement.id);
        git.observeFilesChanged({ sessionId: replacement.id, changes: [{ path: 'tracked.txt' }] });
        await vi.waitFor(() => expect(events).toHaveLength(1));
        expect(events).toHaveLength(1);
        const [event] = events;
        expect(event.event).toBe('git.changed');
        if (event.event === 'git.changed')
            expect(event.payload.sessionIds).toEqual([sibling.id, replacement.id]);
        database.close();
    });

    it('releases lifecycle state after a failed Session summary', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-missing-session-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const service = new GitService(
            new ProjectRootResolver(database),
            createLogger(join(directory, '.logs')),
        );
        const git = trackGitService(service);

        await expect(git.summary('missing-session')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        const internals = service as unknown as GitServiceInternals;
        expect(internals.repositoryService.sessionGenerations.size).toBe(0);
        database.close();
    });

    it('lists and switches only existing local branches', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-branches-'));
        temporaryDirectories.push(directory);
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
            cwd: directory,
        });
        await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], { cwd: directory });
        await writeFile(join(directory, 'tracked.txt'), 'initial\n', 'utf8');
        await execFileAsync('git', ['add', 'tracked.txt'], { cwd: directory });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: directory });
        await execFileAsync('git', ['branch', 'feature/local-picker'], { cwd: directory });
        // A clearly newer commit on main proves the committerdate-first branch ordering;
        // both branches otherwise share the initial commit's timestamp (a refname tie).
        await writeFile(join(directory, 'tracked.txt'), 'newer\n', 'utf8');
        await execFileAsync('git', ['add', 'tracked.txt'], { cwd: directory });
        await execFileAsync('git', ['commit', '-m', 'newer'], {
            cwd: directory,
            env: {
                ...process.env,
                GIT_AUTHOR_DATE: '2099-01-01T00:00:00+00:00',
                GIT_COMMITTER_DATE: '2099-01-01T00:00:00+00:00',
            },
        });

        const database = new CaxriDatabase(join(directory, '.caxri-test.db'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const rootResolver = new ProjectRootResolver(database);
        const gitLogger = createLogger(join(directory, '.logs'));
        const git = trackGitService(
            new GitService(rootResolver, gitLogger, {
                subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve(undefined) }),
            }),
        );
        const repo = (await git.summary(session.id)).repositories[0];

        const branchList = await git.branches({
            sessionId: session.id,
            repositoryId: repo.id,
        });
        expect(branchList.map((candidate) => candidate.name)).toEqual([
            'main',
            'feature/local-picker',
        ]);
        expect(branchList[0].committedAt).toBe(Date.UTC(2099, 0, 1));
        expect(branchList[1].committedAt).toBeTypeOf('number');
        await expect(
            git.switchBranch({
                sessionId: session.id,
                repositoryId: repo.id,
                branch: 'feature/local-picker',
            }),
        ).resolves.toBeNull();
        await expect(
            execFileAsync('git', ['branch', '--show-current'], { cwd: directory }),
        ).resolves.toMatchObject({ stdout: 'feature/local-picker\n' });
        await expect(git.summary(session.id)).resolves.toMatchObject({
            repositories: [expect.objectContaining({ branch: 'feature/local-picker' })],
        });
        await expect(
            git.switchBranch({
                sessionId: session.id,
                repositoryId: repo.id,
                branch: '--discard-changes',
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        database.close();
    });

    it('loads current pull request changes from committed base and head objects only', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-pull-request-'));
        temporaryDirectories.push(directory);
        const repoRoot = join(directory, 'project');
        const bin = join(directory, 'bin');
        await execFileAsync('mkdir', ['-p', repoRoot, bin]);
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoRoot });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
            cwd: repoRoot,
        });
        await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], {
            cwd: repoRoot,
        });
        // The shared GitHub projection keys records by owner/repo, so the pull-request read needs a GitHub `origin`.
        await execFileAsync(
            'git',
            ['remote', 'add', 'origin', 'git@github.com:tjx666/project.git'],
            { cwd: repoRoot },
        );
        await writeFile(join(repoRoot, 'tracked.txt'), 'before\n', 'utf8');
        await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repoRoot });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoRoot });
        const baseOid = (
            await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
        ).stdout.trim();
        await execFileAsync('git', ['switch', '-c', 'feature/pull-request'], {
            cwd: repoRoot,
        });
        await writeFile(join(repoRoot, 'tracked.txt'), 'after\n', 'utf8');
        await writeFile(join(repoRoot, 'pr-only.txt'), 'pull request\n', 'utf8');
        await execFileAsync('git', ['add', 'tracked.txt', 'pr-only.txt'], {
            cwd: repoRoot,
        });
        await execFileAsync('git', ['commit', '-m', 'pull request changes'], {
            cwd: repoRoot,
        });
        const headOid = (
            await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
        ).stdout.trim();
        await writeFile(join(repoRoot, 'tracked.txt'), 'local only\n', 'utf8');
        await writeFile(join(repoRoot, 'untracked-local.txt'), 'local only\n', 'utf8');
        const gh = join(bin, 'gh');
        await writeFile(
            gh,
            `#!/bin/sh\nprintf '%s' '${JSON.stringify({
                baseRefName: 'main',
                baseRefOid: baseOid,
                headRefName: 'feature/pull-request',
                headRefOid: headOid,
                number: 42,
                title: 'Committed pull request range',
                url: 'https://github.com/tjx666/project/pull/42',
            })}'\n`,
            'utf8',
        );
        await chmod(gh, 0o755);

        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(
            database.createProject(repoRoot).id,
            'shell',
        ).session;
        const rootResolver = new ProjectRootResolver(database);
        const gitLogger = createLogger(join(directory, 'logs'));
        /**
         * The production runner resolves login-shell executables, so changing PATH cannot isolate this fixture.
         */
        const externalStatus = new ExternalStatusHub({
            pausePath: join(directory, 'quota.json'),
            runner: async (source, arguments_, cwd) => {
                expect(source).toBe('gh');
                return (await execFileAsync(gh, [...arguments_], { cwd })).stdout;
            },
        });
        const git = trackGitService(new GitService(rootResolver, gitLogger, { externalStatus }));
        const repo = (await git.summary(session.id)).repositories[0];
        try {
            const pullRequest = await git.pullRequestChanges({
                sessionId: session.id,
                repositoryId: repo.id,
                refresh: 0,
            });

            expect(pullRequest).toMatchObject({
                additions: 2,
                baseOid,
                deletions: 1,
                headOid,
                number: 42,
            });
            expect(
                pullRequest?.files.map((file) => file.path).toSorted((a, b) => a.localeCompare(b)),
            ).toEqual(['pr-only.txt', 'tracked.txt']);
            await expect(
                git.pullRequestDiffDocument({
                    sessionId: session.id,
                    repositoryId: repo.id,
                    path: 'tracked.txt',
                }),
            ).resolves.toMatchObject({
                format: 'contents',
                modified: 'after\n',
                original: 'before\n',
                path: 'tracked.txt',
            });

            await execFileAsync('git', ['switch', '-c', 'feature/next-pull-request'], {
                cwd: repoRoot,
            });
            await writeFile(join(repoRoot, 'next-pr.txt'), 'next pull request\n', 'utf8');
            await execFileAsync('git', ['add', 'next-pr.txt'], { cwd: repoRoot });
            await execFileAsync('git', ['commit', '-m', 'next pull request changes'], {
                cwd: repoRoot,
            });
            /**
             * Force a fresh repository snapshot before the next cache lookup. `pullRequestChanges({ refresh: 0 })` keys
             * cache hits on `resolveRepository()`'s branch/head; those come from `summary({ refresh: 0 })`, which can
             * still report the previous generation until the metadata watcher bumps it.
             */
            await git.summary(session.id, 1);
            const nextHeadOid = (
                await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })
            ).stdout.trim();
            await writeFile(
                gh,
                `#!/bin/sh\nprintf '%s' '${JSON.stringify({
                    baseRefName: 'main',
                    baseRefOid: baseOid,
                    headRefName: 'feature/next-pull-request',
                    headRefOid: nextHeadOid,
                    number: 43,
                    title: 'Next pull request range',
                    url: 'https://github.com/tjx666/project/pull/43',
                })}'\n`,
                'utf8',
            );

            await expect(
                git.pullRequestChanges({
                    sessionId: session.id,
                    repositoryId: repo.id,
                    refresh: 0,
                }),
            ).resolves.toMatchObject({ headOid: nextHeadOid, number: 43 });
        } finally {
            database.close();
        }
    });

    it('recognizes an empty repository before its first commit', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-empty-'));
        temporaryDirectories.push(directory);
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
        const database = new CaxriDatabase(join(directory, '.caxri-test.db'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const logger = createLogger(join(directory, '.logs'));
        const paths = new ProjectRootResolver(database);
        const summary = await trackGitService(new GitService(paths, logger)).summary(session.id);

        expect(summary).toMatchObject({
            isRepository: true,
            repositories: [expect.objectContaining({ branch: 'main' })],
        });
        expect(summary.repositories[0].head).toBeUndefined();
        database.close();
    });

    it('returns diff documents for staged gitlinks, renames, and untracked directories', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-special-diffs-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'primary');
        const submoduleSource = join(directory, 'submodule-source');
        await execFileAsync('mkdir', ['-p', root, submoduleSource]);
        await Promise.all(
            [root, submoduleSource].map(async (repo) => {
                await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
                await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
                    cwd: repo,
                });
                await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], {
                    cwd: repo,
                });
            }),
        );
        await writeFile(join(root, 'old.txt'), 'before\n', 'utf8');
        await execFileAsync('git', ['add', 'old.txt'], { cwd: root });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
        await execFileAsync('git', ['commit', '--allow-empty', '-m', 'submodule initial'], {
            cwd: submoduleSource,
        });
        await execFileAsync(
            'git',
            ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSource, 'vendor/sub'],
            { cwd: root },
        );
        await execFileAsync('git', ['commit', '-am', 'add submodule'], { cwd: root });
        await execFileAsync('git', ['mv', 'old.txt', 'renamed.txt'], { cwd: root });
        await execFileAsync('mkdir', ['-p', join(root, 'generated')]);
        await writeFile(join(root, 'generated/new.txt'), 'new\n', 'utf8');
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
            cwd: join(root, 'vendor/sub'),
        });
        await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], {
            cwd: join(root, 'vendor/sub'),
        });
        await execFileAsync('git', ['commit', '--allow-empty', '-m', 'advance submodule'], {
            cwd: join(root, 'vendor/sub'),
        });
        await execFileAsync('git', ['add', 'vendor/sub'], { cwd: root });

        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        const rootResolver = new ProjectRootResolver(database);
        const gitLogger = createLogger(join(directory, 'logs'));
        const git = trackGitService(new GitService(rootResolver, gitLogger));
        const repo = (await git.summary(session.id)).repositories[0];

        expect(repo.files).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'renamed',
                    originalPath: 'old.txt',
                    path: 'renamed.txt',
                }),
                expect.objectContaining({ kind: 'untracked', path: 'generated/new.txt' }),
                expect.objectContaining({ index: 'M', path: 'vendor/sub' }),
            ]),
        );
        await expect(git.diffDocument(session.id, repo.id, 'renamed.txt')).resolves.toMatchObject({
            original: 'before\n',
            originalPath: 'old.txt',
            modified: 'before\n',
        });
        await expect(
            git.diffDocument(session.id, repo.id, 'generated/new.txt'),
        ).resolves.toMatchObject({ original: '', modified: 'new\n' });
        const submoduleDocument = await git.diffDocument(session.id, repo.id, 'vendor/sub');
        expect(submoduleDocument?.format).toBe('patch');
        expect(submoduleDocument?.modified).toContain('Subproject commit');
        database.close();
    });

    it('discovers initialized children without projecting linked worktrees', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-hierarchy-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'owner');
        const linked = join(root, 'feature');
        const submoduleSource = join(directory, 'submodule-source');
        await execFileAsync('mkdir', ['-p', root, submoduleSource]);

        await Promise.all(
            [root, submoduleSource].map(async (repo) => {
                await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
                await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
                    cwd: repo,
                });
                await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], {
                    cwd: repo,
                });
            }),
        );
        await writeFile(join(root, 'root.txt'), 'before\n', 'utf8');
        await execFileAsync('git', ['add', 'root.txt'], { cwd: root });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
        await writeFile(join(submoduleSource, 'submodule.txt'), 'before\n', 'utf8');
        await execFileAsync('git', ['add', 'submodule.txt'], { cwd: submoduleSource });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: submoduleSource });
        await execFileAsync('git', ['worktree', 'add', '-b', 'feature', linked], { cwd: root });
        await execFileAsync(
            'git',
            ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSource, 'vendor/sub'],
            { cwd: root },
        );
        await execFileAsync('git', ['commit', '-am', 'add submodule'], { cwd: root });

        const nested = join(root, 'nested');
        await execFileAsync('mkdir', ['-p', nested]);
        await execFileAsync('git', ['init', '-b', 'nested-main'], { cwd: nested });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: nested });
        await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], { cwd: nested });
        await writeFile(join(nested, 'nested.txt'), 'before\n', 'utf8');
        await execFileAsync('git', ['add', 'nested.txt'], { cwd: nested });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: nested });
        await Promise.all([
            writeFile(join(root, 'root.txt'), 'after\n', 'utf8'),
            writeFile(join(linked, 'root.txt'), 'linked\n', 'utf8'),
            writeFile(join(nested, 'nested.txt'), 'after\n', 'utf8'),
            writeFile(join(root, 'vendor/sub/submodule.txt'), 'after\n', 'utf8'),
        ]);

        const database = new CaxriDatabase(join(directory, 'state.db'));
        const primaryProject = database.createProject(root);
        database.createProject(linked);
        const session = database.createSession(primaryProject.id, 'shell').session;
        const logger = createLogger(join(directory, 'logs'));
        const paths = new ProjectRootResolver(database);
        const git = trackGitService(new GitService(paths, logger));
        const topology = await git.worktreeTopology(root);
        expect(topology.repositoryKey).toBe(await realpath(join(root, '.git')));
        expect(topology.worktrees).toEqual(
            expect.arrayContaining([
                { branch: 'main', rootPath: await realpath(root), isMain: true },
                { branch: 'feature', rootPath: await realpath(linked), isMain: false },
            ]),
        );
        const startedAt = performance.now();
        const summary = await git.summary(session.id);
        const repositories = summary.repositories;

        expect(performance.now() - startedAt).toBeLessThan(3_000);
        expect(
            repositories.map((repo) => repo.kind).toSorted((a, b) => a.localeCompare(b)),
        ).toEqual(['nested', 'primary', 'submodule']);
        const linkedRoot = await realpath(linked);
        expect(repositories.every((repo) => repo.rootPath !== linkedRoot)).toBe(true);
        expect(repositories.find((repo) => repo.kind === 'nested')?.rootPath).toBe(
            await realpath(nested),
        );
        await expect(
            git.diffDocument(session.id, computeRepoId(linkedRoot), 'root.txt'),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        const primary = repositories.find((repo) => repo.kind === 'primary')!;
        expect(
            primary.files.map((file) => file.path).toSorted((a, b) => a.localeCompare(b)),
        ).toEqual(['root.txt', 'vendor/sub']);
        expect(primary.files.find((file) => file.path === 'vendor/sub')).toMatchObject({
            kind: 'modified',
            workingTree: 'M',
        });
        expect(primary.files.some((file) => file.path.startsWith('nested'))).toBe(false);
        const secondaryRepositories = repositories.filter((item) => item.kind !== 'primary');
        await Promise.all(
            secondaryRepositories.map(async (repo) => {
                expect(repo.files).toHaveLength(1);
                await expect(
                    git.commits({
                        sessionId: session.id,
                        repositoryId: repo.id,
                        offset: 0,
                        pageSize: 5,
                    }),
                ).resolves.toMatchObject({ commits: [expect.any(Object)] });
                await expect(
                    git.diffDocument(session.id, repo.id, repo.files[0].path),
                ).resolves.toMatchObject({ path: repo.files[0].path });
            }),
        );
        await expect(git.diffDocument(session.id, primary.id, 'root.txt')).resolves.toMatchObject({
            path: 'root.txt',
        });
        await expect(
            git.commits({
                sessionId: session.id,
                repositoryId: primary.id,
                offset: 0,
                pageSize: 5,
                path: 'root.txt',
            }),
        ).resolves.toMatchObject({ commits: [expect.any(Object)] });
        database.close();
    });

    /**
     * Production sinks run at `info`, and a successful Git command is the highest-volume record Server Core produces:
     * on a real profile it plus `git.summary` filled 87% of a 5MB generation, cutting retention to ~38 hours and
     * evicting the low-volume lifecycle evidence incidents need. The failure path stays at `warn`, so a production log
     * still shows every Git command that went wrong.
     */
    it('keeps a successful Git command out of a production-level log while still recording failures', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-log-level-'));
        temporaryDirectories.push(directory);
        await execFileAsync('git', ['init', '-b', 'main'], { cwd: directory });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
            cwd: directory,
        });
        await execFileAsync('git', ['config', 'user.name', 'Caxri Test'], { cwd: directory });
        await writeFile(join(directory, 'tracked.txt'), 'tracked\n', 'utf8');
        await execFileAsync('git', ['add', 'tracked.txt'], { cwd: directory });
        await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: directory });
        const database = new CaxriDatabase(join(directory, '.caxri-test.db'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const logDirectory = join(directory, '.logs');
        const logger = createLogger(logDirectory, 'server-core', 'info');
        const git = trackGitService(new GitService(new ProjectRootResolver(database), logger));

        const summary = await git.summary(session.id);
        await expect(
            git.commitDetails({
                sessionId: session.id,
                repositoryId: summary.repositories[0].id,
                sha: 'not-a-commit',
            }),
        ).rejects.toThrow();
        await logger.flush();

        const events = (await readFile(join(logDirectory, 'server-core.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => (JSON.parse(line) as { event: string }).event);
        // `git.summary` proves Git actually ran; the per-command success record is what must be absent.
        expect(events).toContain('git.summary');
        expect(events).not.toContain('git.command');
        expect(events).toContain('git.command_failed');
        database.close();
    });
});
