import { describe, expect, it, vi } from 'vitest';

import { ExternalStatusCliError } from '../../../external-status';
import type { BranchPublicationContext } from '../../branch';
import type { VercelDependencies } from '../deployments';
import { loadVercelDeployments, VercelLinkCache } from '../deployments';
import type { GitHubApiRunner } from '../github';
import { loadGitHubDeployments, loadGitHubProduction } from '../github';

const head = 'a'.repeat(40);
const mergeCommit = 'b'.repeat(40);

interface Fixture {
    creator?: string;
    environment: string;
    id: number;
    sha: string;
    status: { state: string; environment_url?: string; target_url?: string };
}

const vercelFixtures: Fixture[] = [
    {
        id: 3,
        sha: head,
        environment: 'Preview',
        status: {
            state: 'success',
            environment_url: 'https://widget-abc.example.vercel.app',
            target_url: 'https://widget-abc.example.vercel.app',
        },
    },
    {
        id: 2,
        sha: mergeCommit,
        environment: 'Production',
        status: {
            state: 'failure',
            target_url: 'https://vercel.com/acme/widget/dpl_failed',
        },
    },
    // Another integration's deployment of the same commit, which is not Vercel's to report.
    {
        id: 1,
        sha: head,
        environment: 'Preview',
        creator: 'github-actions[bot]',
        status: { state: 'success', environment_url: 'https://pages.example.com' },
    },
];

/**
 * Answers like the REST Deployments API: the list filters by `sha` and `environment`, newest first, and each
 * deployment's statuses are read separately.
 */
function githubRunner(fixtures: Fixture[] = vercelFixtures) {
    return vi.fn<GitHubApiRunner>((arguments_) => {
        const url = new URL(arguments_.at(-1) ?? '', 'https://api.github.com/');
        const statuses = /deployments\/(\d+)\/statuses$/.exec(url.pathname);
        if (statuses) {
            const fixture = fixtures.find(({ id }) => id === Number(statuses[1]));
            return Promise.resolve(JSON.stringify(fixture ? [fixture.status] : []));
        }
        const sha = url.searchParams.get('sha');
        const environment = url.searchParams.get('environment');
        return Promise.resolve(
            JSON.stringify(
                fixtures
                    .filter(
                        (fixture) =>
                            (!sha || fixture.sha === sha) &&
                            (!environment || fixture.environment === environment),
                    )
                    .map((fixture) => ({
                        id: fixture.id,
                        sha: fixture.sha,
                        environment: fixture.environment,
                        created_at: '2026-11-19T05:05:38Z',
                        creator: { login: fixture.creator ?? 'vercel[bot]' },
                    })),
            ),
        );
    });
}

describe('GitHub deployments', () => {
    it("rebuilds the head preview and the merge commit's production from Vercel's GitHub records", async () => {
        const deployments = await loadGitHubDeployments(githubRunner(), {
            owner: 'acme',
            repo: 'widget',
            head,
            mergeCommit,
        });

        expect(deployments).toMatchObject({
            source: 'github',
            url: 'https://github.com/acme/widget/deployments',
            preview: {
                environment: 'preview',
                hostname: 'widget-abc.example.vercel.app',
                state: 'success',
                commit: { sha: head, url: `https://github.com/acme/widget/commit/${head}` },
            },
            // A failed build has no site yet, so its row points at Vercel's build page instead.
            production: {
                environment: 'production',
                state: 'failure',
                inspectorUrl: 'https://vercel.com/acme/widget/dpl_failed',
            },
        });
        expect(deployments?.branchDeployments).toEqual([deployments?.preview]);
    });

    it('reports nothing for commits Vercel never deployed', async () => {
        await expect(
            loadGitHubDeployments(githubRunner(), {
                owner: 'acme',
                repo: 'widget',
                head: 'c'.repeat(40),
            }),
        ).resolves.toBeUndefined();
    });

    it("reads the production commit for the Session badge from Vercel's newest Production record", async () => {
        await expect(loadGitHubProduction(githubRunner(), 'acme', 'widget')).resolves.toEqual({
            commitSha: mergeCommit,
            state: 'failure',
        });
    });
});

describe('Vercel deployments falling back to GitHub', () => {
    const context: BranchPublicationContext = {
        branch: 'feat/panel',
        head,
        owner: 'acme',
        repo: 'widget',
        hasOrigin: true,
        detached: false,
    };

    function deniedVercel(kind: 'permission-denied' | 'rate-limited'): VercelDependencies['run'] {
        return vi.fn<VercelDependencies['run']>(() =>
            Promise.reject(new ExternalStatusCliError('vc', kind, 'vc failed')),
        );
    }

    it('shows GitHub deployments instead of the access error when vc is denied', async () => {
        const github = githubRunner();
        const result = await loadVercelDeployments(
            {
                github,
                links: new VercelLinkCache(),
                onParseFailure: () => {},
                run: deniedVercel('permission-denied'),
            },
            context,
            '/project',
        );

        expect(result.errors).toEqual([]);
        expect(result.deployments?.source).toBe('github');
        expect(result.deployments?.preview?.hostname).toBe('widget-abc.example.vercel.app');
    });

    it('keeps a transient vc failure as is rather than asking GitHub', async () => {
        const github = githubRunner();
        const result = await loadVercelDeployments(
            {
                github,
                links: new VercelLinkCache(),
                onParseFailure: () => {},
                run: deniedVercel('rate-limited'),
            },
            context,
            '/project',
        );

        expect(result.deployments).toBeUndefined();
        expect(result.errors).toMatchObject([{ source: 'vercel' }]);
        expect(github).not.toHaveBeenCalled();
    });

    it('stops asking GitHub about a repository Vercel has never deployed until a forced refresh', async () => {
        const links = new VercelLinkCache();
        const github = githubRunner([]);
        const dependencies: VercelDependencies = {
            github,
            links,
            onParseFailure: () => {},
            // No team deploys this repository, so `vc` finds no project.
            run: vi.fn<VercelDependencies['run']>(() => Promise.resolve('[]')),
        };

        const first = await loadVercelDeployments(dependencies, context, '/project');
        expect(first.errors).toMatchObject([{ source: 'vercel' }]);
        const calls = github.mock.calls.length;
        expect(calls).toBeGreaterThan(0);

        await loadVercelDeployments(dependencies, context, '/project');
        expect(github).toHaveBeenCalledTimes(calls);

        await loadVercelDeployments({ ...dependencies, isForced: true }, context, '/project');
        expect(github.mock.calls.length).toBeGreaterThan(calls);
    });
});
