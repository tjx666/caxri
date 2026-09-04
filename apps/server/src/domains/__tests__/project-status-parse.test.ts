import { describe, expect, it } from 'vitest';

import { parseGitHubPullRequest } from '../project-status-parse';

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
