import { rememberBounded } from '@caxri/utils';
import { describe, expect, it } from 'vitest';

import { extractLinearReferences, parseGitHubRemote } from '../project-status';
import type { VercelLink } from '../project-status-external';
import {
    LINEAR_ISSUE_QUERY,
    linearStateColor,
    parseGitHubPullRequest,
    parseVercelList,
} from '../project-status-parse';
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

    it('carries the triggering commit, reduced to its subject line', () => {
        const [deployment] = parseVercelList(
            JSON.stringify({
                deployments: [
                    {
                        uid: 'dpl_Commit123',
                        state: 'READY',
                        url: 'project-commit-team.vercel.app',
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
                { uid: 'dpl_Cli123', state: 'READY', url: 'project-cli-team.vercel.app' },
                'preview',
                link,
            )?.commit,
        ).toBeUndefined();
        expect(
            mapProjectStatusDeployment(
                {
                    uid: 'dpl_Path123',
                    state: 'READY',
                    url: 'project-path-team.vercel.app',
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

describe('Linear workflow state color', () => {
    it.each(['#5E6AD2', '#5e6ad2', '#5E6AD2FF'])('keeps the workspace color %s', (color) => {
        expect(linearStateColor(color)).toBe(color);
    });

    /**
     * The color travels from Linear straight to a `style` attribute on the icon, so anything that is not a hex literal
     * is dropped rather than forwarded. The issue still renders — it just inherits the row's theme color.
     */
    it.each([undefined, '', 'purple', 'rgb(94,106,210)', '#5E6AD', 'url(evil)'])(
        'drops %s, which Caxri cannot render as a color',
        (color) => {
            expect(linearStateColor(color)).toBeUndefined();
        },
    );

    it('asks Linear for the state color alongside its name and type', () => {
        expect(LINEAR_ISSUE_QUERY).toContain('state{name type color}');
    });
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
