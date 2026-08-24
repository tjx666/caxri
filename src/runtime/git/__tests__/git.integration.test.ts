import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeEvent } from '../../../shared/ipc/events';
import { execFileAsync } from '../../../shared/node/exec';
import { StructuredLogger } from '../../../shared/node/logger';
import { CaxriDatabase } from '../../db/repository';
import { ProjectRootResolver } from '../../project-roots';
import { describeGitFailure, GitService } from '..';
import type { GitMetadataWatcher } from '../metadata-watcher';

const temporaryDirectories: string[] = [];
const gitServices: GitService[] = [];

interface GitServiceInternals {
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
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('GitService', () => {
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
        const gitLogger = new StructuredLogger(join(directory, '.logs'));
        const git = trackGitService(new GitService(rootResolver, gitLogger));

        await expect(git.blame({ sessionId: session.id, path, line: 2 })).resolves.toMatchObject({
            author: 'Caxri Test',
            line: 2,
            subject: 'add source',
            uncommitted: false,
        });
        await rm(path);
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
        const logger = new StructuredLogger(join(directory, '.logs'));
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
        const events: RuntimeEvent[] = [];
        const logger = new StructuredLogger(join(directory, '.logs'));
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
            new StructuredLogger(join(directory, '.logs')),
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
        const gitLogger = new StructuredLogger(join(directory, '.logs'));
        const git = trackGitService(new GitService(rootResolver, gitLogger));
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
        const gitLogger = new StructuredLogger(join(directory, 'logs'));
        const git = trackGitService(new GitService(rootResolver, gitLogger));
        const repo = (await git.summary(session.id)).repositories[0];
        const previousPath = process.env.PATH;
        process.env.PATH = `${bin}:${previousPath ?? ''}`;
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
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
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
        const logger = new StructuredLogger(join(directory, '.logs'));
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
        const gitLogger = new StructuredLogger(join(directory, 'logs'));
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
        expect(submoduleDocument.format).toBe('patch');
        expect(submoduleDocument.modified).toContain('Subproject commit');
        database.close();
    });

    it('discovers approved worktrees, nested repositories, and submodules independently', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-hierarchy-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'primary');
        const linked = join(directory, 'linked');
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
        const logger = new StructuredLogger(join(directory, 'logs'));
        const paths = new ProjectRootResolver(database);
        const git = trackGitService(new GitService(paths, logger));
        const topology = await git.worktreeTopology(root);
        expect(topology.repositoryKey).toBe(await realpath(join(root, '.git')));
        expect(topology.worktrees).toEqual(
            expect.arrayContaining([
                { branch: 'main', rootPath: await realpath(root) },
                { branch: 'feature', rootPath: await realpath(linked) },
            ]),
        );
        const startedAt = performance.now();
        const summary = await git.summary(session.id);
        const repositories = summary.repositories;

        expect(performance.now() - startedAt).toBeLessThan(3_000);
        expect(
            repositories.map((repo) => repo.kind).toSorted((a, b) => a.localeCompare(b)),
        ).toEqual(['nested', 'primary', 'submodule', 'worktree']);
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
});

describe('describeGitFailure', () => {
    it('distinguishes missing Git and timeout failures from non-repositories', () => {
        const missingGitError = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
        expect(describeGitFailure(missingGitError)).toBe(
            'Git is not installed or is unavailable on PATH.',
        );
        const timedOutError = Object.assign(new Error('timed out'), { killed: true });
        expect(describeGitFailure(timedOutError)).toBe('The Git operation timed out.');
        const notARepoError = Object.assign(new Error('exit 128'), {
            stderr: 'fatal: not a git repository',
        });
        expect(describeGitFailure(notARepoError)).toBe('The Project root is not a Git repository.');
    });
});
