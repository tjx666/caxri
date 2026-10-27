import { rememberBounded } from '@caxri/utils';
import { describe, expect, it } from 'vitest';

import { extractLinearReferences, parseGitHubRemote } from '..';
import type { VercelLink } from '../external';
import { parseGitHubPullRequest, parseVercelList } from '../parse';
import { mapProjectStatusDeployment } from '../vercel';

describe('Vercel deployment details', () => {
    it.each(['CANCELED', 'ERROR', 'READY', 'BUILDING'])(
        'preserves the deployment ID and details link for %s',
        (state) => {
            const [deployment] = parseVercelList(
                JSON.stringify({
                    deployments: [
                        {
                            uid: 'dpl_Deployment123',
                            name: 'project',
                            state,
                            url: 'app-alias.example.vercel.app',
                            created: 1_700_000_000_000,
                        },
                    ],
                }),
            );
            expect(
                mapProjectStatusDeployment(deployment, 'preview', {
                    team: 'team',
                    project: 'project',
                }),
            ).toMatchObject({ inspectorUrl: 'https://vercel.com/team/project/Deployment123' });
        },
    );

    it('keeps supported deployments when the provider returns incomplete and staging entries', () => {
        const deployments = parseVercelList(
            JSON.stringify({
                deployments: [
                    {
                        uid: 'dpl_Ready123',
                        name: 'project',
                        state: 'READY',
                        target: 'production',
                        url: 'app-ready.example.vercel.app',
                        inspectorUrl: 'https://vercel.com/team/project/provider-details',
                        created: 3,
                    },
                    {
                        uid: 'dpl_Building123',
                        name: 'project',
                        state: 'BUILDING',
                        target: null,
                        url: null,
                        created: 2,
                    },
                    {
                        uid: 'dpl_Staging123',
                        name: 'project',
                        state: 'READY',
                        target: 'staging',
                        url: 'app-staging.example.vercel.app',
                        created: 1,
                    },
                ],
            }),
        );
        const mapped = deployments.flatMap((deployment) => {
            const result = mapProjectStatusDeployment(deployment, undefined, {
                team: 'team',
                project: 'project',
            });
            return result ? [result] : [];
        });

        expect(mapped).toEqual([
            expect.objectContaining({
                environment: 'production',
                hostname: 'app-ready.example.vercel.app',
                inspectorUrl: 'https://vercel.com/team/project/provider-details',
            }),
        ]);
        expect(
            mapProjectStatusDeployment(deployments[2], 'preview', {
                team: 'team',
                project: 'project',
            }),
        ).toBeUndefined();
        expect(
            mapProjectStatusDeployment(
                {
                    uid: 'dpl_Fallback123',
                    state: 'READY',
                    url: 'app-fallback.example.vercel.app',
                    inspectorUrl: 'https://example.com/untrusted',
                },
                'preview',
                { team: 'team', project: 'project' },
            ),
        ).toMatchObject({ inspectorUrl: 'https://vercel.com/team/project/Fallback123' });
    });

    it.each([
        { readyState: 'QUEUED', state: 'queued' },
        { readyState: 'INITIALIZING', state: 'pending' },
        { readyState: 'BUILDING', state: 'pending' },
    ])('reports $readyState as $state', ({ readyState, state }) => {
        const [deployment] = parseVercelList(
            JSON.stringify({
                deployments: [
                    {
                        uid: 'dpl_State123',
                        readyState,
                        url: 'app-state.example.vercel.app',
                    },
                ],
            }),
        );

        expect(
            mapProjectStatusDeployment(deployment, 'production', {
                team: 'team',
                project: 'project',
            }),
        ).toMatchObject({ state });
    });

    it('carries the triggering commit, reduced to its subject line', () => {
        const [deployment] = parseVercelList(
            JSON.stringify({
                deployments: [
                    {
                        uid: 'dpl_Commit123',
                        state: 'READY',
                        url: 'app-commit.example.vercel.app',
                        meta: {
                            githubCommitAuthorLogin: 'octocat',
                            githubCommitMessage: 'fix: stop the timeout\n\nLong body nobody reads.',
                            githubCommitOrg: 'acme',
                            githubCommitRepo: 'web',
                            githubCommitSha: 'b5bae57a270864fdd9c238a8c1fc6a0d9f04d3c5',
                        },
                    },
                ],
            }),
        );

        expect(
            mapProjectStatusDeployment(deployment, 'preview', { team: 'team', project: 'project' })
                ?.commit,
        ).toEqual({
            sha: 'b5bae57a270864fdd9c238a8c1fc6a0d9f04d3c5',
            message: 'fix: stop the timeout',
            authorLogin: 'octocat',
            url: 'https://github.com/acme/web/commit/b5bae57a270864fdd9c238a8c1fc6a0d9f04d3c5',
        });
    });

    it('omits the commit for a direct upload and the commit link for an unusable repository', () => {
        const link = { team: 'team', project: 'project' };

        expect(
            mapProjectStatusDeployment(
                { uid: 'dpl_Cli123', state: 'READY', url: 'app-cli.example.vercel.app' },
                'preview',
                link,
            )?.commit,
        ).toBeUndefined();
        expect(
            mapProjectStatusDeployment(
                {
                    uid: 'dpl_Path123',
                    state: 'READY',
                    url: 'app-path.example.vercel.app',
                    meta: {
                        githubCommitOrg: '../evil',
                        githubCommitRepo: 'web',
                        githubCommitSha: 'b5bae57a270864fdd9c238a8c1fc6a0d9f04d3c5',
                    },
                },
                'preview',
                link,
            )?.commit,
        ).toEqual({ sha: 'b5bae57a270864fdd9c238a8c1fc6a0d9f04d3c5' });
    });
});

describe('parseGitHubPullRequest', () => {
    it.each(['OPEN', 'CLOSED', 'MERGED'])(
        'only associates a production commit with a merged PR (%s)',
        (state) => {
            const result = parseGitHubPullRequest(
                JSON.stringify({
                    number: 42,
                    title: 'Delivery',
                    url: 'https://github.com/acme/widget/pull/42',
                    state,
                    mergeCommit: { oid: 'b'.repeat(40) },
                }),
            );
            expect(result.mergeCommit).toBe(state === 'MERGED' ? 'b'.repeat(40) : undefined);
        },
    );

    it.each([
        [{ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }, 'clean'],
        [{ mergeable: 'MERGEABLE', mergeStateStatus: 'HAS_HOOKS' }, 'clean'],
        [{ mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE' }, 'unstable'],
        [{ mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' }, 'blocked'],
        [{ mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' }, 'behind'],
        [{ mergeable: 'CONFLICTING', mergeStateStatus: 'UNKNOWN' }, 'conflicting'],
        [{ mergeable: 'UNKNOWN', mergeStateStatus: 'DIRTY' }, 'conflicting'],
        [{ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }, 'unknown'],
        [{}, undefined],
    ])('reduces GitHub mergeability %o to %s', (fields, mergeState) => {
        const result = parseGitHubPullRequest(
            JSON.stringify({
                number: 42,
                title: 'Delivery',
                url: 'https://github.com/acme/widget/pull/42',
                state: 'OPEN',
                headRefOid: 'a'.repeat(40),
                ...fields,
            }),
        ).pullRequest;
        expect(result?.mergeState).toBe(mergeState);
        expect(result?.headSha).toBe('a'.repeat(40));
    });

    it.each([
        [undefined, 'cancelled'],
        ['SUCCESS', 'success'],
        ['IN_PROGRESS', 'pending'],
        ['FAILURE', 'failure'],
    ])('keeps a cancelled child while aggregating %s checks', (other, state) => {
        const result = parseGitHubPullRequest(
            JSON.stringify({
                number: 1,
                title: 'PR',
                url: 'https://github.com/a/b/pull/1',
                statusCheckRollup: [
                    { name: 'cancelled', status: 'COMPLETED', conclusion: 'CANCELLED' },
                    ...(other
                        ? [
                              {
                                  name: 'other',
                                  status: other === 'IN_PROGRESS' ? other : 'COMPLETED',
                                  conclusion: other === 'IN_PROGRESS' ? null : other,
                              },
                          ]
                        : []),
                ],
            }),
        ).pullRequest;
        expect(result?.state).toBe(state);
        expect(result?.checks.find((check) => check.name === 'cancelled')?.state).toBe('cancelled');
    });

    /**
     * A queue of twenty checks and a run with twenty checks going are not the same news, and the panel draws them with
     * different glyphs. The rollup keeps them apart too: `pending` only once something has actually started.
     */
    it('separates a check waiting for a runner from one that is executing', () => {
        const result = parseGitHubPullRequest(
            JSON.stringify({
                number: 7,
                title: 'PR',
                url: 'https://github.com/a/b/pull/7',
                statusCheckRollup: [
                    { name: 'waiting', status: 'QUEUED', conclusion: null },
                    { name: 'expected', state: 'EXPECTED' },
                    { name: 'done', status: 'COMPLETED', conclusion: 'SUCCESS' },
                ],
            }),
        ).pullRequest;

        expect(result?.checks.find((check) => check.name === 'waiting')?.state).toBe('queued');
        expect(result?.checks.find((check) => check.name === 'expected')?.state).toBe('queued');
        expect(result?.state).toBe('queued');

        const started = parseGitHubPullRequest(
            JSON.stringify({
                number: 7,
                title: 'PR',
                url: 'https://github.com/a/b/pull/7',
                statusCheckRollup: [
                    { name: 'waiting', status: 'QUEUED', conclusion: null },
                    { name: 'running', status: 'IN_PROGRESS', conclusion: null },
                ],
            }),
        ).pullRequest;

        expect(started?.checks.find((check) => check.name === 'running')?.state).toBe('pending');
        expect(started?.state).toBe('pending');
    });

    /**
     * The reading order is what went wrong, then what is still moving, then what is settled. A state the order forgot
     * sorts to `-1` and lands above the failures, so the panel's first row would be the one nothing has happened to.
     */
    it('lists every check state after the failures rather than above them', () => {
        const result = parseGitHubPullRequest(
            JSON.stringify({
                number: 9,
                title: 'PR',
                url: 'https://github.com/a/b/pull/9',
                statusCheckRollup: [
                    { name: 'unrecognized', status: 'SOMETHING_NEW' },
                    { name: 'passed', status: 'COMPLETED', conclusion: 'SUCCESS' },
                    { name: 'cancelled', status: 'COMPLETED', conclusion: 'CANCELLED' },
                    { name: 'queued', status: 'QUEUED' },
                    { name: 'running', status: 'IN_PROGRESS' },
                    { name: 'broken', status: 'COMPLETED', conclusion: 'FAILURE' },
                ],
            }),
        ).pullRequest;

        expect(result?.checks.map((check) => [check.name, check.state])).toEqual([
            ['broken', 'failure'],
            ['running', 'pending'],
            ['queued', 'queued'],
            ['cancelled', 'cancelled'],
            ['passed', 'success'],
            ['unrecognized', 'neutral'],
        ]);
    });

    it.each([
        ['MERGED', false, 'merged'],
        ['CLOSED', true, 'closed'],
        ['OPEN', true, 'draft'],
        ['OPEN', false, 'open'],
        [undefined, false, undefined],
    ])(
        'preserves PR lifecycle %s independently of successful checks',
        (state, isDraft, lifecycle) => {
            expect(
                parseGitHubPullRequest(
                    JSON.stringify({
                        number: 42,
                        title: 'Lifecycle fixture',
                        url: 'https://github.com/a/b/pull/42',
                        state,
                        isDraft,
                        statusCheckRollup: [{ name: 'Build', conclusion: 'SUCCESS' }],
                    }),
                ).pullRequest,
            ).toMatchObject({ lifecycle, state: 'success' });
        },
    );

    it('rejects malformed GitHub pull request JSON as VALIDATION', () => {
        expect(() => parseGitHubPullRequest('{')).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }) as Error,
        );
        expect(() => parseGitHubPullRequest(JSON.stringify({ number: '11', title: 2 }))).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }) as Error,
        );
    });

    it('maps failed checks ahead of successful checks', () => {
        expect(
            parseGitHubPullRequest(
                JSON.stringify({
                    number: 1,
                    title: 'PR',
                    url: 'https://github.com/a/b/pull/1',
                    statusCheckRollup: [
                        { conclusion: 'SUCCESS', name: 'pass' },
                        { conclusion: 'FAILURE', name: 'fail' },
                    ],
                }),
            ).pullRequest,
        ).toMatchObject({ state: 'failure', checks: [{ name: 'fail' }, { name: 'pass' }] });
    });

    it('drops ignored checks from the rollup and counts them as hidden', () => {
        expect(
            parseGitHubPullRequest(
                JSON.stringify({
                    number: 1,
                    title: 'PR',
                    url: 'https://github.com/a/b/pull/1',
                    statusCheckRollup: [
                        { conclusion: 'SUCCESS', name: 'unit' },
                        { conclusion: 'FAILURE', context: 'codecov/patch' },
                    ],
                }),
                ['codecov/*'],
            ).pullRequest,
        ).toMatchObject({ state: 'success', checks: [{ name: 'unit' }], hiddenCheckCount: 1 });
    });

    it('settles as neutral when every check the pull request has is ignored', () => {
        expect(
            parseGitHubPullRequest(
                JSON.stringify({
                    number: 1,
                    title: 'PR',
                    url: 'https://github.com/a/b/pull/1',
                    statusCheckRollup: [{ conclusion: 'FAILURE', name: 'flaky' }],
                }),
                ['flaky'],
            ).pullRequest,
        ).toMatchObject({ state: 'neutral', checks: [], hiddenCheckCount: 1 });
    });

    it('keeps an empty rollup pending, because GitHub has not reported a check yet', () => {
        expect(
            parseGitHubPullRequest(
                JSON.stringify({ number: 1, title: 'PR', url: 'https://github.com/a/b/pull/1' }),
                ['flaky'],
            ).pullRequest,
        ).toMatchObject({ state: 'pending', hiddenCheckCount: 0 });
    });

    it.each(['MERGED', 'CLOSED'])(
        'settles an empty rollup on a %s pull request as neutral, because no check will ever arrive',
        (state) => {
            expect(
                parseGitHubPullRequest(
                    JSON.stringify({
                        number: 1,
                        title: 'PR',
                        url: 'https://github.com/a/b/pull/1',
                        state,
                        statusCheckRollup: [],
                    }),
                ).pullRequest,
            ).toMatchObject({ state: 'neutral', checks: [], hiddenCheckCount: 0 });
        },
    );
});

describe('Project Status parsers', () => {
    it('accepts HTTPS and SSH GitHub remotes', () => {
        expect(parseGitHubRemote('git@github.com:example/caxri.git')).toEqual({
            owner: 'example',
            repo: 'caxri',
        });
        expect(parseGitHubRemote('https://github.com/example/caxri')).toEqual({
            owner: 'example',
            repo: 'caxri',
        });
    });

    it('extracts deliberate Linear references without treating bare mentions as links', () => {
        expect(
            extractLinearReferences(
                'Follow-up TASK-1\nFixes TASK-2, TASK-3\nhttps://linear.app/example/issue/TASK-4/title',
            ),
        ).toEqual([
            { identifier: 'TASK-4', workspace: 'example' },
            { identifier: 'TASK-2', workspace: undefined },
            { identifier: 'TASK-3', workspace: undefined },
        ]);
    });

    it('keeps prose out of the reference list when a keyword appears mid-sentence', () => {
        expect(
            extractLinearReferences(
                'Fixes TASK-24682\n\nThis fixes local installs creating a root pnpm-lock.yaml. The packageManager SHA-512 value matches the published npm artifact.\n\nTracked in https://linear.app/example/issue/TASK-24681.',
            ),
        ).toEqual([
            { identifier: 'TASK-24681', workspace: 'example' },
            { identifier: 'TASK-24682', workspace: undefined },
        ]);
    });

    it('accepts the connectors Linear magic words actually use', () => {
        expect(extractLinearReferences('Closes TASK-1 and TASK-2')).toEqual([
            { identifier: 'TASK-1', workspace: undefined },
            { identifier: 'TASK-2', workspace: undefined },
        ]);
        expect(extractLinearReferences('Resolves issue TASK-3')).toEqual([
            { identifier: 'TASK-3', workspace: undefined },
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
