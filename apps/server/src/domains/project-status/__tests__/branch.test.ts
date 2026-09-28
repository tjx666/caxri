import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GitSummary } from '@caxri/protocol';
import { execFileAsync, StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import type { ExternalStatusRunner } from '../../external-status';
import { ExternalStatusCliError } from '../../external-status';
import { ProjectStatusService } from '..';
import {
    loadBranchPublication,
    prepareStatusRepo,
    RemoteHeadCache,
    RepoRemoteCache as RepoRemoteCache,
} from '../branch';

const head = 'a'.repeat(40);
const remoteHead = 'b'.repeat(40);
const context = {
    branch: 'feature/status',
    head,
    owner: 'acme',
    repo: 'project',
    hasOrigin: true,
    detached: false,
};

function runnerFor(reference: unknown): ExternalStatusRunner {
    return vi.fn<ExternalStatusRunner>((source, arguments_) => {
        if (source === 'gh')
            return Promise.resolve(JSON.stringify({ data: { repository: { ref: reference } } }));
        if (arguments_[0] === 'rev-parse') return Promise.resolve('false');
        if (arguments_[0] === 'rev-list') return Promise.resolve('2\t1');
        return Promise.resolve('');
    });
}

describe('branch publication', () => {
    it('counts a real diverged history and distinguishes a branch named detached from detached HEAD', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-publication-git-'));
        const git = async (arguments_: readonly string[]): Promise<string> =>
            (await execFileAsync('git', [...arguments_], { cwd: root })).stdout.trim();
        try {
            await git(['init', '-b', 'detached']);
            await git(['config', 'user.name', 'Fixture']);
            await git(['config', 'user.email', 'fixture@caxri.test']);
            await git(['commit', '--allow-empty', '-m', 'Base']);
            const base = await git(['rev-parse', 'HEAD']);
            await git(['commit', '--allow-empty', '-m', 'Local']);
            const local = await git(['rev-parse', 'HEAD']);
            await git(['checkout', '-b', 'remote-fixture', base]);
            await git(['commit', '--allow-empty', '-m', 'Remote']);
            const remote = await git(['rev-parse', 'HEAD']);
            const runner: ExternalStatusRunner = (source, arguments_) =>
                source === 'git'
                    ? git(arguments_)
                    : Promise.resolve(
                          JSON.stringify({
                              data: { repository: { ref: { target: { oid: remote } } } },
                          }),
                      );
            // HEAD intentionally remains on the other branch: comparison must use the captured local OID.
            expect(
                await loadBranchPublication({ ...context, head: local }, runner, root, () => 123),
            ).toMatchObject({ state: 'diverged', ahead: 1, behind: 1 });
            await git(['checkout', 'detached']);
            const repo: GitSummary['repositories'][number] = {
                id: 'repo',
                kind: 'primary',
                rootPath: root,
                name: 'project',
                branch: 'detached',
                head: local,
                ahead: 0,
                behind: 0,
                additions: 0,
                deletions: 0,
                generation: 0,
                changedFileCount: 0,
                truncated: false,
                files: [],
            };
            const optionalGit = async (
                _cwd: string,
                arguments_: readonly string[],
            ): Promise<string> => {
                try {
                    return await git(arguments_);
                } catch {
                    return '';
                }
            };
            expect((await prepareStatusRepo(repo, optionalGit)).repository.publication?.state).toBe(
                'no-origin',
            );
            await git(['checkout', '--detach', local]);
            expect(
                (await prepareStatusRepo({ ...repo, branch: '(detached)' }, optionalGit)).repository
                    .publication?.state,
            ).toBe('detached');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('rechecks after push without a HEAD change and fails closed on refresh', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-publication-'));
        const logger = new StructuredLogger(directory);
        let trackingHead = '';
        let isRemoteExists = false;
        let isOffline = false;
        const emitted = vi.fn();
        const runner = vi.fn<ExternalStatusRunner>((source, arguments_) => {
            if (source === 'git') {
                if (arguments_[0] === 'remote')
                    return Promise.resolve('https://github.com/acme/project.git');
                if (arguments_[0] === 'symbolic-ref')
                    return Promise.resolve(
                        arguments_.includes('HEAD') ? 'feature/status' : 'origin/main',
                    );
                if (arguments_.includes('--verify')) return Promise.resolve(trackingHead);
                return Promise.resolve(head);
            }
            if (source === 'gh') {
                if (isOffline)
                    return Promise.reject(new ExternalStatusCliError('gh', 'timeout', 'offline'));
                if (arguments_[0] === 'api')
                    return Promise.resolve(
                        JSON.stringify({
                            data: {
                                repository: {
                                    ref: isRemoteExists ? { target: { oid: head } } : null,
                                },
                            },
                        }),
                    );
                return Promise.reject(new Error('no pull requests found'));
            }
            return Promise.resolve('{"teams":[]}');
        });
        const summary: GitSummary = {
            isRepository: true,
            repositories: [
                {
                    id: 'repo',
                    kind: 'primary',
                    rootPath: '/project',
                    name: 'project',
                    branch: context.branch,
                    head,
                    ahead: 0,
                    behind: 0,
                    additions: 0,
                    deletions: 0,
                    generation: 0,
                    changedFileCount: 0,
                    truncated: false,
                    files: [],
                },
            ],
        };
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(summary) },
            logger,
            runner,
            { emit: emitted },
        );
        try {
            const initial = await service.summary('publication-session');
            expect(initial.repositories[0]).toMatchObject({ publication: { state: 'checking' } });
            expect(initial.repositories[0].branchUrl).toBeUndefined();
            await vi.waitFor(() => expect(emitted).toHaveBeenCalledTimes(1));
            expect((await service.summary('publication-session')).repositories[0]).toMatchObject({
                publication: { state: 'unpublished' },
            });
            trackingHead = head;
            isRemoteExists = true;
            await service.summary('publication-session');
            await vi.waitFor(() => expect(emitted).toHaveBeenCalledTimes(2));
            expect((await service.summary('publication-session')).repositories[0]).toMatchObject({
                publication: { state: 'synced' },
                branchUrl: 'https://github.com/acme/project/tree/feature%2Fstatus',
            });
            isOffline = true;
            const failed = (await service.summary('publication-session', 'offline-refresh'))
                .repositories[0];
            expect(failed.publication?.state).toBe('unknown');
            expect(failed.branchUrl).toBeUndefined();
            expect(failed.errors.filter((error) => error.source === 'github')).toHaveLength(1);
        } finally {
            service.dispose();
            await logger.flush();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('does not treat a different upstream or stale tracking ref as publication', async () => {
        expect(
            await loadBranchPublication(context, runnerFor(null), '/project', () => 123),
        ).toEqual({ state: 'unpublished', remoteBranch: 'origin/feature/status', checkedAt: 123 });
    });

    it('confirms equality from the live remote commit without needing local remote refs', async () => {
        expect(
            await loadBranchPublication(
                context,
                runnerFor({ target: { oid: head } }),
                '/project',
                () => 123,
            ),
        ).toMatchObject({ state: 'synced', checkedAt: 123 });
    });

    it('compares immutable commits only when complete history is locally available', async () => {
        expect(
            await loadBranchPublication(
                context,
                runnerFor({ target: { oid: remoteHead } }),
                '/project',
                () => 123,
            ),
        ).toMatchObject({ state: 'diverged', ahead: 2, behind: 1 });
    });

    it.each(['true', 'missing'])(
        'keeps remote existence separate from unavailable history: %s',
        async (history) => {
            const base = runnerFor({ target: { oid: remoteHead } });
            const runner: ExternalStatusRunner = (source, arguments_, cwd) => {
                if (source === 'git' && history === 'missing')
                    return Promise.reject(new Error('object unavailable'));
                if (source === 'git' && arguments_[0] === 'rev-parse')
                    return Promise.resolve(history);
                return base(source, arguments_, cwd);
            };
            expect(
                await loadBranchPublication(context, runner, '/project', () => 123),
            ).toMatchObject({ state: 'published' });
        },
    );

    it.each([null, {}, { ref: { target: { oid: '--unsafe' } } }])(
        'rejects inaccessible or malformed repository evidence: %j',
        async (repo) => {
            const runner: ExternalStatusRunner = () =>
                Promise.resolve(JSON.stringify({ data: { repository: repo } }));
            await expect(
                loadBranchPublication(context, runner, '/project', () => 123),
            ).rejects.toThrow();
        },
    );

    it('rejects partial GraphQL errors instead of claiming an absent branch', async () => {
        const runner: ExternalStatusRunner = () =>
            Promise.resolve(
                JSON.stringify({
                    data: { repository: { ref: null } },
                    errors: [{ message: 'unavailable' }],
                }),
            );
        await expect(
            loadBranchPublication(context, runner, '/project', () => 123),
        ).rejects.toThrow();
    });

    it.each([
        [{ detached: true }, 'detached'],
        [{ head: undefined }, 'unborn'],
        [{ hasOrigin: false }, 'no-origin'],
        [{ owner: undefined }, 'unsupported'],
    ] as const)('does not query GitHub for local-only context %j', async (patch, state) => {
        const runner = runnerFor(null);
        expect(
            await loadBranchPublication({ ...context, ...patch }, runner, '/project', () => 123),
        ).toMatchObject({ state });
        expect(runner).not.toHaveBeenCalled();
    });

    it('reuses the remote branch commit until the tracking ref moves, the TTL expires, or a refresh is forced', async () => {
        let now = 0;
        const cache = new RemoteHeadCache(() => now);
        const runner = runnerFor({ target: { oid: head } });
        const graphqlCalls = () =>
            vi.mocked(runner).mock.calls.filter(([source]) => source === 'gh').length;
        const load = (
            patch: Partial<typeof context & { trackingHead: string }> = {},
            isForced = false,
        ) =>
            loadBranchPublication({ ...context, ...patch }, runner, '/project', () => now, {
                cache,
                isForced,
            });

        await expect(load()).resolves.toMatchObject({ state: 'synced' });
        await load();
        await load({ owner: 'acme', repo: 'project', branch: 'feature/status' });
        expect(graphqlCalls()).toBe(1);

        await load({ trackingHead: head });
        expect(graphqlCalls()).toBe(2);

        await load({ trackingHead: head }, true);
        expect(graphqlCalls()).toBe(3);

        await load({ branch: 'feature/other', trackingHead: head });
        expect(graphqlCalls()).toBe(4);

        now = 5 * 60_000;
        await load({ trackingHead: head });
        expect(graphqlCalls()).toBe(5);
    });

    it('reports the earlier probe time on a cache hit instead of the current call time', async () => {
        let now = 1_000;
        const cache = new RemoteHeadCache(() => now);
        const runner = runnerFor({ target: { oid: head } });
        const load = () =>
            loadBranchPublication(context, runner, '/project', () => now, {
                cache,
                isForced: false,
            });

        await expect(load()).resolves.toMatchObject({ checkedAt: 1_000 });
        now = 2_000;
        // Still inside the TTL and the tracking ref has not moved, so this is a cache hit: `checkedAt` must stay the
        // first probe's time rather than jumping to this call's `now()`.
        await expect(load()).resolves.toMatchObject({ checkedAt: 1_000 });
        expect(vi.mocked(runner).mock.calls.filter(([source]) => source === 'gh').length).toBe(1);

        now = 3_000;
        await expect(load()).resolves.toMatchObject({ checkedAt: 1_000 });

        now = 5 * 60_000 + 1_000;
        // Past the TTL: a fresh probe runs, so `checkedAt` moves to this call's own time.
        await expect(load()).resolves.toMatchObject({ checkedAt: now });
    });

    it('asks GitHub again after a failed remote branch lookup', async () => {
        const cache = new RemoteHeadCache(() => 0);
        let isOffline = true;
        const runner = vi.fn<ExternalStatusRunner>((source) =>
            source === 'gh' && isOffline
                ? Promise.reject(new ExternalStatusCliError('gh', 'timeout', 'offline'))
                : Promise.resolve(JSON.stringify({ data: { repository: { ref: null } } })),
        );
        const load = () =>
            loadBranchPublication(context, runner, '/project', () => 0, { cache, isForced: false });

        await expect(load()).rejects.toThrow('offline');
        isOffline = false;
        await expect(load()).resolves.toMatchObject({ state: 'unpublished' });
        expect(runner).toHaveBeenCalledTimes(2);
    });

    it('reuses origin and its default branch across rounds until the TTL or a forced refresh', async () => {
        let now = 0;
        const remotes = new RepoRemoteCache(() => now);
        const git = vi.fn((_cwd: string, arguments_: readonly string[]) =>
            Promise.resolve(
                arguments_[0] === 'remote' ? 'git@github.com:acme/project.git' : 'origin/main',
            ),
        );
        const reads = () => git.mock.calls.length;

        await remotes.read('/project', git);
        await remotes.read('/project', git);
        expect(reads()).toBe(2);

        await remotes.read('/project', git, true);
        expect(reads()).toBe(4);

        now = 5 * 60_000;
        await expect(remotes.read('/project', git)).resolves.toEqual({
            remote: 'git@github.com:acme/project.git',
            defaultBranch: 'origin/main',
        });
        expect(reads()).toBe(6);
    });
});
