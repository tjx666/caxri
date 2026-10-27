import type { GitSummary, ServerEvent } from '@caxri/protocol';
import { defaultAppSettings } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExternalStatusRunner } from '../../external-status';
import { ExternalStatusCliError } from '../../external-status';
import { ProjectStatusService } from '..';
import {
    checkPayload,
    cleanupProjectStatusFixtures,
    githubOnlyRunner,
    gitSummary,
    logger,
} from './project-status.fixture';

afterEach(cleanupProjectStatusFixtures);

describe('ProjectStatusService', () => {
    it('returns local status before a slow external CLI refresh completes', async () => {
        const external = Promise.withResolvers<string>();
        const refreshed = Promise.withResolvers<void>();
        const runner = vi.fn<ExternalStatusRunner>((command, arguments_) => {
            if (command === 'git' && arguments_[0] === 'remote') {
                return Promise.resolve('git@github.com:example/project.git\n');
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
                url: 'https://github.com/example/project/pull/7',
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
                return Promise.resolve('git@github.com:example/project.git\n');
            }
            if (command === 'git') return Promise.resolve('');
            if (command === 'gh') {
                if (pullRequestNumber === 8) return forcedGithub.promise;
                return Promise.resolve(
                    JSON.stringify({
                        number: pullRequestNumber,
                        title: `Pull request ${pullRequestNumber}`,
                        url: `https://github.com/example/project/pull/${pullRequestNumber}`,
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
                url: 'https://github.com/example/project/pull/8',
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
                return Promise.resolve('git@github.com:example/project.git\n');
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
                url: 'https://github.com/example/project/pull/9',
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

    it('assembles GitHub, Linear, and Vercel status with structured CLI arguments', async () => {
        const refreshed = Promise.withResolvers<void>();
        const runner = vi.fn<ExternalStatusRunner>((command, arguments_) => {
            if (command === 'git' && arguments_[0] === 'remote') {
                return Promise.resolve('git@github.com:example/project.git\n');
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
                        body: 'Fixes TASK-42',
                        number: 7,
                        title: 'Ship status panel',
                        url: 'https://github.com/example/project/pull/7',
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
                                identifier: 'TASK-42',
                                title: 'Project Status',
                                url: 'https://linear.app/example/issue/TASK-42',
                                state: { name: 'In Progress', type: 'started' },
                            },
                        },
                    }),
                );
            }
            if (command === 'vc' && arguments_[0] === 'teams') {
                return Promise.resolve(JSON.stringify({ teams: [{ slug: 'example' }] }));
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
                            url: `app-${environment}.example.vercel.app`,
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
                            url: 'branch.example.vercel.app',
                        },
                    ]),
                );
            }
            if (command === 'vc') {
                return Promise.resolve(
                    JSON.stringify([{ name: 'project', url: 'discovery.example.vercel.app' }]),
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
                    identifier: 'TASK-42',
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
            inspectorUrl: 'https://vercel.com/example/project/production',
        });
        expect(repo.deployments?.preview).toMatchObject({
            environment: 'preview',
            inspectorUrl: 'https://vercel.com/example/project/preview',
        });
        expect(runner.mock.calls.filter(([command]) => command === 'gh')).toHaveLength(2);
        expect(runner.mock.calls.find(([command]) => command === 'linear')?.[1]).toContain(
            'id=TASK-42',
        );
    });

    it('keeps the last known pull request when a later refresh is rate limited', async () => {
        let isLimited = false;
        const emitted = vi.fn();
        const runner = vi.fn<ExternalStatusRunner>((command, arguments_) => {
            if (command === 'git' && arguments_[0] === 'remote') {
                return Promise.resolve('git@github.com:example/project.git\n');
            }
            if (command === 'git') return Promise.resolve('');
            if (command === 'gh' && arguments_[0] === 'api')
                return Promise.resolve(JSON.stringify({ data: { repository: { ref: null } } }));
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
                        url: 'https://github.com/example/project/pull/7',
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

    it('keeps the last delivery status while a moved HEAD on the same branch revalidates', async () => {
        let head = 'a'.repeat(40);
        let branch = 'feature/status';
        const emitted = vi.fn();
        const runner = vi.fn<ExternalStatusRunner>((command, arguments_) => {
            if (command === 'git' && arguments_[0] === 'remote')
                return Promise.resolve('git@github.com:example/project.git\n');
            if (command === 'git' && arguments_.join(' ') === 'rev-parse HEAD')
                return Promise.resolve(head);
            if (
                command === 'git' &&
                arguments_[0] === 'symbolic-ref' &&
                arguments_[1] === '--quiet'
            )
                return Promise.resolve(branch);
            if (command === 'git') return Promise.resolve('');
            if (command === 'gh' && arguments_[0] === 'api')
                return Promise.resolve(JSON.stringify({ data: { repository: { ref: null } } }));
            if (command === 'gh') {
                return Promise.resolve(
                    JSON.stringify({
                        number: 7,
                        title: 'Pull request 7',
                        url: 'https://github.com/example/project/pull/7',
                    }),
                );
            }
            return Promise.resolve(JSON.stringify({ teams: [] }));
        });
        const service = new ProjectStatusService(
            {
                summary: () =>
                    Promise.resolve({
                        ...gitSummary,
                        repositories: gitSummary.repositories.map((repo) => ({ ...repo, branch })),
                    }),
            },
            await logger(),
            runner,
            { emit: emitted },
        );

        await service.summary('session-1');
        await vi.waitFor(() => expect(emitted).toHaveBeenCalledTimes(1));
        expect((await service.summary('session-1')).repositories[0]?.pullRequest?.number).toBe(7);

        // An Agent commits while the user looks at another Session: the fingerprint moves with HEAD, but the branch
        // and its pull request did not, so returning must not blank the panel back to a local-only summary.
        head = 'b'.repeat(40);
        const moved = await service.summary('session-1');
        expect(moved.repositories[0]?.pullRequest?.number).toBe(7);

        // A different branch owns a different pull request, so nothing carries over.
        branch = 'feature/other';
        const switched = await service.summary('session-1');
        expect(switched.repositories[0]?.branch).toBe('feature/other');
        expect(switched.repositories[0]?.pullRequest).toBeUndefined();
    });

    it('keeps repositories visible when integrations fail', async () => {
        const refreshed = Promise.withResolvers<void>();
        const runner = vi.fn<ExternalStatusRunner>((command, arguments_) => {
            if (command === 'git' && arguments_[0] === 'remote') {
                return Promise.resolve('https://github.com/example/project.git');
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
        /*
         * A queued run is the snapshot most likely to be stale a second later, and the move to "running" is the one
         * transition the split between the two states exists to show. Pacing it like a settled pull request would
         * report "not started" for two minutes after it started.
         */
        { check: { name: 'unit', status: 'QUEUED' }, delayMs: 20_000, label: 'a queued job' },
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
            service.setPolledSessions(new Set(['session-1']));
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

        service.setPolledSessions(new Set(['session-1']));
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
                // Time never advances, so only the fingerprint (never a TTL) can invalidate the cached summary.
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
            vi
                .mocked(runner)
                .mock.calls.filter(
                    ([command, arguments_]) => command === 'gh' && arguments_[0] === 'pr',
                ).length;

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
                        url: 'https://github.com/example/project/pull/7',
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
