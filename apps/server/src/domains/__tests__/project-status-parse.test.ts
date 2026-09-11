import { describe, expect, it } from 'vitest';

import { parseGitHubPullRequest, parseVercelList } from '../project-status-parse';
import { mapProjectStatusDeployment } from '../project-status-vercel';

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
                            url: 'project-alias-team.vercel.app',
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
                        url: 'project-ready-team.vercel.app',
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
                        url: 'project-staging-team.vercel.app',
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
                hostname: 'project-ready-team.vercel.app',
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
                    url: 'project-fallback-team.vercel.app',
                    inspectorUrl: 'https://example.com/untrusted',
                },
                'preview',
                { team: 'team', project: 'project' },
            ),
        ).toMatchObject({ inspectorUrl: 'https://vercel.com/team/project/Fallback123' });
    });
});

describe('parseGitHubPullRequest', () => {
    it.each([
        [undefined, 'cancelled'],
        ['SUCCESS', 'cancelled'],
        ['IN_PROGRESS', 'pending'],
        ['FAILURE', 'failure'],
    ])('preserves cancellation alongside %s checks', (other, state) => {
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
});
