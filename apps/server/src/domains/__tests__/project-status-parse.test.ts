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
});

describe('parseGitHubPullRequest', () => {
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
