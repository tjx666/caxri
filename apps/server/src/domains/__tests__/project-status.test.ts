import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GitSummary, ServerEvent } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { rememberBounded } from '@caxri/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExternalStatusRunner } from '../external-status';
import { ExternalStatusCliError } from '../external-status';
import {
    extractLinearReferences,
    parseGitHubRemote,
    ProjectStatusService,
} from '../project-status';
import type { VercelLink } from '../project-status-external';

const temporaryDirectories: string[] = [];
const loggers: StructuredLogger[] = [];

afterEach(async () => {
    const pendingLoggers = loggers.slice();
    loggers.length = 0;
    await Promise.all(pendingLoggers.map((instance) => instance.flush()));
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

async function logger(): Promise<StructuredLogger> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-project-status-'));
    temporaryDirectories.push(directory);
    const instance = new StructuredLogger(directory);
    loggers.push(instance);
    return instance;
}
/**
 * A GitHub fixture that can provide a linked Vercel project for cache timing tests.
 */
function githubOnlyRunner(
    pullRequest: () => unknown,
    hasLinkedVercel = false,
): ExternalStatusRunner {
    return vi.fn<ExternalStatusRunner>((command, arguments_) => {
        if (command === 'git' && arguments_[0] === 'remote')
            return Promise.resolve('git@github.com:lobehub/project.git\n');
        if (command === 'git') return Promise.resolve('');
        if (command === 'gh') return Promise.resolve(JSON.stringify(pullRequest()));
        if (hasLinkedVercel && command === 'vc') {
            if (arguments_[0] === 'teams')
                return Promise.resolve(JSON.stringify({ teams: [{ slug: 'team' }] }));
            const query = arguments_[1] ?? '';
            if (!query.includes('meta-githubCommit') && !query.includes('target='))
                return Promise.resolve(JSON.stringify([{ name: 'project' }]));
            return Promise.resolve('[]');
        }
        return Promise.resolve(JSON.stringify({ teams: [] }));
    });
}

function checkPayload(check: Record<string, unknown>): unknown {
    return {
        number: 7,
        title: 'Ship status panel',
        url: 'https://github.com/lobehub/project/pull/7',
        statusCheckRollup: [check],
    };
}

const gitSummary: GitSummary = {
    isRepository: true,
    repositories: [
        {
            id: 'repo-1',
            kind: 'primary',
            name: 'project',
            rootPath: '/project',
            branch: 'feature/status',
            head: '1234567',
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

describe('ProjectStatusService', () => {
    it('returns local status before a slow external CLI refresh completes', async () => {
        const external = Promise.withResolvers<string>();
        const refreshed = Promise.withResolvers<void>();
        const runner = vi.fn<ExternalStatusRunner>((command, arguments_) => {
            if (command === 'git' && arguments_[0] === 'remote') {
                return Promise.resolve('git@github.com:lobehub/project.git\n');
            }
            if (command === 'git') return Promise.resolve('');
            return external.promise;
        });
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            runner,
            {
                emit: (event) => {
                    if (event.event === 'projectStatus.changed') refreshed.resolve();
                },
            },
        );

        const summary = await service.summary('session-1');
        expect(summary.repositories[0]?.branch).toBe('feature/status');
        expect(summary.repositories[0]?.pullRequest).toBeUndefined();

        external.resolve(
            JSON.stringify({
                number: 7,
                title: 'Ship status panel',
                url: 'https://github.com/lobehub/project/pull/7',
            }),
        );
        await refreshed.promise;
        const cached = await service.summary('session-1');

        expect(cached.repositories[0]).toMatchObject({ pullRequest: { number: 7 } });
    });

    it('uses a refresh token to bypass a fresh cache exactly once', async () => {
        let pullRequestNumber = 7;
        const forcedGithub = Promise.withResolvers<string>();
        const emitted = vi.fn();
        const runner = vi.fn<ExternalStatusRunner>((command, arguments_) => {
            if (command === 'git' && arguments_[0] === 'remote') {
                return Promise.resolve('git@github.com:lobehub/project.git\n');
            }
            if (command === 'git') return Promise.resolve('');
            if (command === 'gh') {
                if (pullRequestNumber === 8) return forcedGithub.promise;
                return Promise.resolve(
                    JSON.stringify({
                        number: pullRequestNumber,
                        title: `Pull request ${pullRequestNumber}`,
                        url: `https://github.com/lobehub/project/pull/${pullRequestNumber}`,
                    }),
                );
            }
            return Promise.resolve(JSON.stringify({ teams: [] }));
        });
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            runner,
            { emit: emitted },
        );

        await service.summary('session-1');
        await vi.waitFor(() => expect(emitted).toHaveBeenCalledTimes(1));
        expect((await service.summary('session-1')).repositories[0]?.pullRequest?.number).toBe(7);

        pullRequestNumber = 8;
        let isForcedSettled = false;
        const forced = service.summary('session-1', 'refresh-1');
        const observeForcedSettlement = async (): Promise<void> => {
            await forced;
            isForcedSettled = true;
        };
        const forcedSettlement = observeForcedSettlement();
        await vi.waitFor(() =>
            expect(runner.mock.calls.filter(([command]) => command === 'gh')).toHaveLength(2),
        );
        expect(isForcedSettled).toBe(false);
        forcedGithub.resolve(
            JSON.stringify({
                number: 8,
                title: 'Pull request 8',
                url: 'https://github.com/lobehub/project/pull/8',
            }),
        );
        await forcedSettlement;
        expect((await forced).repositories[0]?.pullRequest?.number).toBe(8);
        await vi.waitFor(() => expect(emitted).toHaveBeenCalledTimes(2));
        expect(
            (await service.summary('session-1', 'refresh-1')).repositories[0]?.pullRequest?.number,
        ).toBe(8);
        const externalCalls = runner.mock.calls.filter(([command]) => command !== 'git').length;

        await service.summary('session-1', 'refresh-1');
        expect(runner.mock.calls.filter(([command]) => command !== 'git')).toHaveLength(
            externalCalls,
        );
    });

    it('discards a background refresh after its Session is evicted', async () => {
        const externalStarted = Promise.withResolvers<void>();
        const external = Promise.withResolvers<string>();
        const emitted = vi.fn();
        const runner = vi.fn<ExternalStatusRunner>((command, arguments_) => {
            if (command === 'git' && arguments_[0] === 'remote') {
                return Promise.resolve('git@github.com:lobehub/project.git\n');
            }
            if (command === 'git') return Promise.resolve('');
            if (command === 'gh') {
                externalStarted.resolve();
                return external.promise;
            }
            return Promise.resolve(JSON.stringify({ teams: [] }));
        });
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            runner,
            { emit: emitted },
        );

        const refresh = service.summary('session-1', 'refresh-before-delete');
        await externalStarted.promise;
        service.evictSessions(['session-1']);
        external.resolve(
            JSON.stringify({
                number: 9,
                title: 'Late pull request',
                url: 'https://github.com/lobehub/project/pull/9',
            }),
        );

        expect((await refresh).repositories[0]?.pullRequest).toBeUndefined();
        expect(emitted).not.toHaveBeenCalled();
    });

    it('does not restore an evicted Session cache after local preparation finishes', async () => {
        const pendingSummary = Promise.withResolvers<GitSummary>();
        const emitted = vi.fn();
        const git = vi.fn((sessionId: string) =>
            sessionId === 'session-a' ? pendingSummary.promise : Promise.resolve(gitSummary),
        );
        const runner = vi.fn<ExternalStatusRunner>(() => Promise.resolve(''));
        const service = new ProjectStatusService({ summary: git }, await logger(), runner, {
            emit: emitted,
        });

        await service.summary('session-b');
        await vi.waitFor(() => expect(emitted).toHaveBeenCalledOnce());
        emitted.mockClear();
        const stale = service.summary('session-a');
        await vi.waitFor(() => expect(git).toHaveBeenCalledWith('session-a', 0, 'projectStatus'));
        service.evictSessions(['session-a']);
        pendingSummary.resolve(gitSummary);
        await stale;
        await new Promise((resolve) => setTimeout(resolve, 0));

        const summaries = (service as unknown as { summaries: Map<string, unknown> }).summaries;
        expect(summaries.has('session-a')).toBe(false);
        expect(summaries.has('session-b')).toBe(true);
        expect(emitted).not.toHaveBeenCalled();

        await service.summary('session-b', 'refresh-live-sibling');
        expect(emitted).toHaveBeenCalledWith({
            event: 'projectStatus.changed',
            payload: { sessionId: 'session-b' },
        });
    });

    it('loads a lightweight primary repository overview without Linear or Vercel', async () => {
        const summaryWithChanges: GitSummary = {
            ...gitSummary,
            repositories: [
                {
                    ...gitSummary.repositories[0],
                    additions: 2,
                    deletions: 1,
                    files: [
                        {
                            index: ' ',
                            kind: 'modified',
                            path: 'src/status.ts',
                            workingTree: 'M',
                        },
                    ],
                },
            ],
        };
        const runner = vi.fn<ExternalStatusRunner>((command, arguments_) => {
            if (command === 'git') return Promise.resolve('git@github.com:lobehub/project.git\n');
            if (command === 'gh') {
                return Promise.resolve(
                    JSON.stringify({
                        number: 11,
                        title: 'Status Bar context',
                        url: 'https://github.com/lobehub/project/pull/11',
                    }),
                );
            }
            return Promise.reject(
                new Error(`Unexpected command: ${command} ${arguments_.join(' ')}`),
            );
        });
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(summaryWithChanges) },
            await logger(),
            runner,
        );

        const [overview, concurrent] = await Promise.all([
            service.overview('session-1'),
            service.overview('session-1'),
        ]);

        expect(concurrent).toEqual(overview);
        expect(overview.repository).toEqual({
            id: 'repo-1',
            branch: 'feature/status',
            branchUrl: 'https://github.com/lobehub/project/tree/feature%2Fstatus',
            changedFileCount: 1,
            additions: 2,
            deletions: 1,
            pullRequest: {
                number: 11,
                title: 'Status Bar context',
                url: 'https://github.com/lobehub/project/pull/11',
            },
        });
        expect(runner.mock.calls.filter(([command]) => command === 'gh')).toHaveLength(1);
        expect(
            runner.mock.calls.some(([command]) => command === 'linear' || command === 'vc'),
        ).toBe(false);
        expect(runner.mock.calls.find(([command]) => command === 'gh')?.[1]).toEqual([
            'pr',
            'view',
            'feature/status',
            '--repo',
            'lobehub/project',
            '--json',
            'number,title,url,state,isDraft,body,statusCheckRollup,baseRefName,headRefName,baseRefOid,headRefOid',
        ]);
    });

    it('assembles GitHub, Linear, and Vercel status with structured CLI arguments', async () => {
        const refreshed = Promise.withResolvers<void>();
        const runner = vi.fn<ExternalStatusRunner>((command, arguments_) => {
            if (command === 'git' && arguments_[0] === 'remote') {
                return Promise.resolve('git@github.com:lobehub/project.git\n');
            }
            if (command === 'git' && arguments_[0] === 'symbolic-ref') {
                return Promise.resolve('origin/main\n');
            }
            if (command === 'git' && arguments_[0] === 'rev-parse') {
                return Promise.resolve('1234567890abcdef\n');
            }
            if (command === 'gh' && arguments_[0] === 'api') {
                return Promise.resolve(JSON.stringify({ data: { repository: { ref: null } } }));
            }
            if (command === 'gh') {
                return Promise.resolve(
                    JSON.stringify({
                        body: 'Fixes LOBE-42',
                        number: 7,
                        title: 'Ship status panel',
                        url: 'https://github.com/lobehub/project/pull/7',
                        statusCheckRollup: [
                            {
                                conclusion: 'SUCCESS',
                                name: 'App',
                                status: 'COMPLETED',
                                workflowName: 'Test',
                            },
                        ],
                    }),
                );
            }
            if (command === 'linear') {
                return Promise.resolve(
                    JSON.stringify({
                        data: {
                            issue: {
                                identifier: 'LOBE-42',
                                title: 'Project Status',
                                url: 'https://linear.app/lobehub/issue/LOBE-42',
                                state: { name: 'In Progress', type: 'started' },
                            },
                        },
                    }),
                );
            }
            if (command === 'vc' && arguments_[0] === 'teams') {
                return Promise.resolve(JSON.stringify({ teams: [{ slug: 'lobehub' }] }));
            }
            if (command === 'vc' && arguments_[1]?.includes('target=')) {
                const environment = new URL(
                    arguments_[1],
                    'https://api.vercel.com',
                ).searchParams.get('target');
                return Promise.resolve(
                    JSON.stringify([
                        {
                            created: 1_700_000_000_000,
                            uid: `dpl_${environment}`,
                            name: 'project',
                            readyState: 'READY',
                            target: environment,
                            url: `project-${environment}-lobehub.vercel.app`,
                        },
                    ]),
                );
            }
            if (
                command === 'vc' &&
                arguments_.some((value) => value.includes('githubCommitRef='))
            ) {
                return Promise.resolve(
                    JSON.stringify([
                        {
                            name: 'project',
                            readyState: 'BUILDING',
                            target: 'preview',
                            url: 'branch.vercel.app',
                        },
                    ]),
                );
            }
            if (command === 'vc') {
                return Promise.resolve(
                    JSON.stringify([{ name: 'project', url: 'discovery.vercel.app' }]),
                );
            }
            return Promise.reject(
                new Error(`Unexpected command: ${command} ${arguments_.join(' ')}`),
            );
        });
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            runner,
            {
                emit: (event) => {
                    if (event.event === 'projectStatus.changed') refreshed.resolve();
                },
            },
        );

        const [local, concurrent] = await Promise.all([
            service.summary('session-1'),
            service.summary('session-1'),
        ]);
        expect(concurrent).toEqual(local);
        expect(local.repositories[0]?.pullRequest).toBeUndefined();
        await refreshed.promise;
        const summary = await service.summary('session-1');

        const repo = summary.repositories[0];
        expect(repo).toMatchObject({
            name: 'project',
            branch: 'feature/status',
            defaultBranch: 'main',
            pullRequest: {
                number: 7,
                state: 'success',
                checks: [{ name: 'Test / App', state: 'success' }],
            },
            linearIssues: [
                {
                    identifier: 'LOBE-42',
                    title: 'Project Status',
                    state: 'In Progress',
                    stateType: 'started',
                },
            ],
            errors: [],
        });
        expect(repo.deployments?.branchDeployments[0]).toMatchObject({ state: 'pending' });
        expect(repo.deployments?.production).toMatchObject({
            environment: 'production',
            createdAt: 1_700_000_000_000,
            inspectorUrl: 'https://vercel.com/lobehub/project/production',
        });
        expect(repo.deployments?.preview).toMatchObject({
            environment: 'preview',
            inspectorUrl: 'https://vercel.com/lobehub/project/preview',
        });
        expect(runner.mock.calls.filter(([command]) => command === 'gh')).toHaveLength(2);
        expect(runner.mock.calls.find(([command]) => command === 'linear')?.[1]).toContain(
            'id=LOBE-42',
        );
    });

    it('keeps the last known pull request when a later refresh is rate limited', async () => {
        let isLimited = false;
        const emitted = vi.fn();
        const runner = vi.fn<ExternalStatusRunner>((command, arguments_) => {
            if (command === 'git' && arguments_[0] === 'remote') {
                return Promise.resolve('git@github.com:lobehub/project.git\n');
            }
            if (command === 'git') return Promise.resolve('');
            if (command === 'gh') {
                if (isLimited) {
                    return Promise.reject(
                        new ExternalStatusCliError('gh', 'rate-limited', 'API rate limit exceeded'),
                    );
                }
                return Promise.resolve(
                    JSON.stringify({
                        number: 7,
                        title: 'Pull request 7',
                        url: 'https://github.com/lobehub/project/pull/7',
                    }),
                );
            }
            return Promise.resolve(JSON.stringify({ teams: [] }));
        });
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            runner,
            { emit: emitted },
        );

        await service.summary('session-1');
        await vi.waitFor(() => expect(emitted).toHaveBeenCalledTimes(1));
        expect((await service.summary('session-1')).repositories[0]?.pullRequest?.number).toBe(7);

        // A transient limit must not swap a good pull request for an error banner for the whole pause: that is the
        // symptom the shared projection exists to remove, and the pause can run for an hour.
        isLimited = true;
        const refreshed = await service.summary('session-1', 'refresh-1');

        expect(refreshed.repositories[0]?.pullRequest?.number).toBe(7);
        expect(refreshed.repositories[0]?.errors).not.toContainEqual(
            expect.objectContaining({ source: 'github' }),
        );
    });

    it('keeps repositories visible when integrations fail', async () => {
        const refreshed = Promise.withResolvers<void>();
        const runner = vi.fn<ExternalStatusRunner>((command, arguments_) => {
            if (command === 'git' && arguments_[0] === 'remote') {
                return Promise.resolve('https://github.com/lobehub/project.git');
            }
            if (command === 'git') return Promise.resolve('');
            return Promise.reject(new Error(`${command} unavailable`));
        });
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            runner,
            {
                emit: (event) => {
                    if (event.event === 'projectStatus.changed') refreshed.resolve();
                },
            },
        );

        const local = await service.summary('session-1');
        expect(local.repositories[0]?.errors).toEqual([]);
        await refreshed.promise;
        const externalCalls = runner.mock.calls.filter(([command]) => command !== 'git').length;
        const summary = await service.summary('session-1');
        const cached = await service.summary('session-1');

        expect(summary.repositories[0]).toMatchObject({
            branch: 'feature/status',
            errors: [
                expect.objectContaining({ source: 'github' }),
                expect.objectContaining({ source: 'vercel' }),
            ],
        });
        expect(cached).toEqual(summary);
        expect(runner.mock.calls.filter(([command]) => command !== 'git')).toHaveLength(
            externalCalls,
        );
    });

    it.each([
        { check: { name: 'unit', status: 'IN_PROGRESS' }, delayMs: 20_000, label: 'a running job' },
        {
            check: { name: 'unit', conclusion: 'SUCCESS' },
            delayMs: 120_000,
            label: 'a settled pull request',
        },
    ])(
        'polls the selected Session in the background, revisiting $label after $delayMs ms',
        async ({ check, delayMs }) => {
            const timers: Array<{ callback: () => void; delayMs: number }> = [];
            const service = new ProjectStatusService(
                { summary: () => Promise.resolve(gitSummary) },
                await logger(),
                githubOnlyRunner(() => checkPayload(check), true),
                {
                    clearTimer: () => {},
                    now: () => 1_000_000,
                    setTimer: (callback, armedDelayMs) => {
                        timers.push({ callback, delayMs: armedDelayMs });
                        return { unref: () => {} } as unknown as NodeJS.Timeout;
                    },
                    settings: () => defaultAppSettings,
                },
            );

            // Nothing is cached yet, so the first arm falls back to the floor rather than firing immediately.
            service.setPolledSession('session-1');
            expect(timers).toHaveLength(1);
            expect(timers[0]?.delayMs).toBe(15_000);

            timers.at(-1)!.callback();
            await vi.waitFor(() => expect(timers.at(-1)?.delayMs).toBe(delayMs));

            const armed = timers.length;
            service.dispose();
            expect(timers).toHaveLength(armed);
        },
    );

    it('stops polling a Session that has been deleted', async () => {
        const timers: Array<{ callback: () => void; delayMs: number }> = [];
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            githubOnlyRunner(() => checkPayload({ name: 'unit', conclusion: 'SUCCESS' })),
            {
                clearTimer: () => {},
                setTimer: (callback, delayMs) => {
                    timers.push({ callback, delayMs });
                    return { unref: () => {} } as unknown as NodeJS.Timeout;
                },
                settings: () => defaultAppSettings,
            },
        );

        service.setPolledSession('session-1');
        service.evictSessions(['session-1']);
        const armed = timers.length;
        timers.at(-1)!.callback();
        await vi.waitFor(() => expect(timers).toHaveLength(armed));
    });

    it('re-parses a cached summary when the ignored checks change, without a second gh query', async () => {
        let ignoredChecks: string[] = [];
        const runner = githubOnlyRunner(() =>
            checkPayload({ name: 'flaky', conclusion: 'FAILURE' }),
        );
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            runner,
            {
                // Time never advances, so only the fingerprint — never a TTL — can invalidate the cached summary.
                now: () => 1_000_000,
                settings: () => ({
                    ...defaultAppSettings,
                    'projectStatus.ignoredChecks': ignoredChecks,
                }),
            },
        );
        const state = async (): Promise<string | undefined> =>
            (await service.summary('session-1')).repositories[0]?.pullRequest?.state;
        const ghCalls = (): number =>
            vi.mocked(runner).mock.calls.filter(([command]) => command === 'gh').length;

        await vi.waitFor(async () => expect(await state()).toBe('failure'));
        const queried = ghCalls();

        ignoredChecks = ['flaky'];
        await vi.waitFor(async () => expect(await state()).toBe('neutral'));
        // The shared pull-request record answers the re-parse, so correcting the rollup is free.
        expect(ghCalls()).toBe(queried);
    });

    it('emits a delivery alert when a check turns into a failure', async () => {
        let conclusion = 'SUCCESS';
        const emitted = vi.fn<(event: ServerEvent) => void>();
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            githubOnlyRunner(() => checkPayload({ name: 'unit', conclusion })),
            { emit: emitted, settings: () => defaultAppSettings },
        );

        await service.summary('session-1');
        await vi.waitFor(() => expect(emitted).toHaveBeenCalled());
        conclusion = 'FAILURE';
        await service.summary('session-1', 'refresh-1');

        const alerts = (): ServerEvent[] =>
            emitted.mock.calls
                .map(([event]) => event)
                .filter((event) => event.event === 'projectStatus.alert');
        await vi.waitFor(() =>
            expect(alerts()).toEqual([
                {
                    event: 'projectStatus.alert',
                    payload: {
                        sessionId: 'session-1',
                        kind: 'check',
                        repository: 'project',
                        branch: 'feature/status',
                        name: 'unit',
                        // No `detailsUrl`, so the alert falls back to the pull request itself.
                        url: 'https://github.com/lobehub/project/pull/7',
                    },
                },
            ]),
        );
    });

    it('keeps the alert baseline current while notifications are disabled, and stays silent', async () => {
        let conclusion = 'SUCCESS';
        const emitted = vi.fn<(event: ServerEvent) => void>();
        const service = new ProjectStatusService(
            { summary: () => Promise.resolve(gitSummary) },
            await logger(),
            githubOnlyRunner(() => checkPayload({ name: 'unit', conclusion })),
            {
                emit: emitted,
                settings: () => ({
                    ...defaultAppSettings,
                    'projectStatus.notifications.enabled': false,
                }),
            },
        );

        await service.summary('session-1');
        await vi.waitFor(() => expect(emitted).toHaveBeenCalled());
        conclusion = 'FAILURE';
        await service.summary('session-1', 'refresh-1');
        await vi.waitFor(() => expect(emitted).toHaveBeenCalledTimes(2));

        expect(emitted.mock.calls.some(([event]) => event.event === 'projectStatus.alert')).toBe(
            false,
        );
    });
});

describe('Project Status parsers', () => {
    it('accepts HTTPS and SSH GitHub remotes', () => {
        expect(parseGitHubRemote('git@github.com:lobehub/caxri.git')).toEqual({
            owner: 'lobehub',
            repo: 'caxri',
        });
        expect(parseGitHubRemote('https://github.com/lobehub/caxri')).toEqual({
            owner: 'lobehub',
            repo: 'caxri',
        });
    });

    it('extracts deliberate Linear references without treating bare mentions as links', () => {
        expect(
            extractLinearReferences(
                'Follow-up LOBE-1\nFixes LOBE-2, LOBE-3\nhttps://linear.app/lobehub/issue/LOBE-4/title',
            ),
        ).toEqual([
            { identifier: 'LOBE-4', workspace: 'lobehub' },
            { identifier: 'LOBE-2', workspace: undefined },
            { identifier: 'LOBE-3', workspace: undefined },
        ]);
    });

    it('keeps prose out of the reference list when a keyword appears mid-sentence', () => {
        expect(
            extractLinearReferences(
                'Fixes LOBE-14029\n\nThis fixes local installs creating a root pnpm-lock.yaml. The packageManager SHA-512 value matches the published npm artifact.\n\nTracked in https://linear.app/lobehub/issue/LOBE-14028.',
            ),
        ).toEqual([
            { identifier: 'LOBE-14028', workspace: 'lobehub' },
            { identifier: 'LOBE-14029', workspace: undefined },
        ]);
    });

    it('accepts the connectors Linear magic words actually use', () => {
        expect(extractLinearReferences('Closes LOBE-1 and LOBE-2')).toEqual([
            { identifier: 'LOBE-1', workspace: undefined },
            { identifier: 'LOBE-2', workspace: undefined },
        ]);
        expect(extractLinearReferences('Resolves issue LOBE-3')).toEqual([
            { identifier: 'LOBE-3', workspace: undefined },
        ]);
        expect(extractLinearReferences('Fixes #12 and pnpm-12 regressions')).toEqual([]);
    });

    it('bounds the vercelLinks cache under many distinct keys, evicting least-recently-used entries', () => {
        const links = new Map<string, VercelLink>();
        const maximum = 256;
        for (let index = 0; index < maximum + 50; index += 1) {
            rememberBounded(
                links,
                `owner/repo-${index}`,
                { team: 'team', project: `project-${index}` },
                maximum,
            );
        }
        expect(links.size).toBe(maximum);
        // The earliest-inserted keys should have been evicted first.
        expect(links.has('owner/repo-0')).toBe(false);
        expect(links.has('owner/repo-49')).toBe(false);
        expect(links.has(`owner/repo-${maximum + 49}`)).toBe(true);
    });
});
