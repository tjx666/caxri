import { describe, expect, it, vi } from 'vitest';

import type { BranchPublicationContext } from '../branch';
import type { VercelDependencies } from '../vercel';
import { findVercelLink, loadVercelDeployments, VercelLinkCache } from '../vercel';

const featureHead = 'a'.repeat(40);
const defaultHead = 'b'.repeat(40);
const link = { team: 'team', project: 'widget' };

interface Fixture {
    readyState: string;
    ref: string;
    sha: string;
    target: 'production' | 'preview';
    uid: string;
    url: string;
}

const fixtures: Fixture[] = [
    {
        readyState: 'READY',
        ref: 'main',
        sha: defaultHead,
        target: 'production',
        uid: 'dpl_default_production',
        url: 'widget-default-production.vercel.app',
    },
    {
        readyState: 'READY',
        ref: 'feat/panel',
        sha: featureHead,
        target: 'preview',
        uid: 'dpl_feature_preview',
        url: 'widget-feature-preview.vercel.app',
    },
];

/**
 * Answers like `/v6/deployments` does: every `meta-*` pair and `target` narrows the list, so what a query omits is what
 * it accepts. A fake that ignored the filters would pass whatever scope the caller asked for.
 */
function vercelRunner(productionState = 'READY'): VercelDependencies['run'] {
    return vi.fn<VercelDependencies['run']>((arguments_) => {
        const query = new URL(arguments_[1] ?? '', 'https://api.vercel.com').searchParams;
        const matching = fixtures.filter((fixture) => {
            const facts: Record<string, string> = {
                'meta-githubCommitRef': fixture.ref,
                'meta-githubCommitSha': fixture.sha,
                'meta-githubOrg': 'acme',
                'meta-githubRepo': 'widget',
                'target': fixture.target,
            };
            return Object.entries(facts).every(([key, value]) => {
                const requested = query.get(key);
                return requested === null || requested === value;
            });
        });
        return Promise.resolve(
            JSON.stringify(
                matching.map((fixture) => ({
                    created: 1_700_000_000_000,
                    readyState:
                        fixture.target === 'production' ? productionState : fixture.readyState,
                    target: fixture.target,
                    uid: fixture.uid,
                    url: fixture.url,
                    meta: {
                        githubCommitRef: fixture.ref,
                        githubCommitSha: fixture.sha,
                        githubOrg: 'acme',
                        githubRepo: 'widget',
                    },
                })),
            ),
        );
    });
}

function linkedCache(): VercelLinkCache {
    const links = new VercelLinkCache();
    links.set('acme/widget', link);
    return links;
}

function dependencies(productionState = 'READY'): VercelDependencies {
    return {
        links: linkedCache(),
        onParseFailure: (error) => expect.unreachable(`unexpected parse failure: ${String(error)}`),
        run: vercelRunner(productionState),
    };
}

function contextFor(branch: string, head: string): BranchPublicationContext {
    return { branch, head, owner: 'acme', repo: 'widget', hasOrigin: true, detached: false };
}

describe('Vercel deployments', () => {
    it.each([
        ['READY', 'success'],
        ['BUILDING', 'pending'],
        ['ERROR', 'failure'],
    ])('reports merged PR production %s on the target branch', async (providerState, state) => {
        const { deployments } = await loadVercelDeployments(
            dependencies(providerState),
            contextFor('feat/panel', featureHead),
            '/project',
            defaultHead,
        );
        expect(deployments?.production).toMatchObject({
            environment: 'production',
            state,
            commit: { sha: defaultHead },
        });
        expect(deployments?.preview?.commit?.sha).toBe(featureHead);
        expect(deployments?.branchDeployments).toHaveLength(1);
    });

    it("reads HEAD's preview from the branch list and queries it only when the list lacks it", async () => {
        const covered = dependencies();
        const { deployments } = await loadVercelDeployments(
            covered,
            contextFor('feat/panel', featureHead),
            '/project',
        );
        expect(deployments?.preview?.commit?.sha).toBe(featureHead);
        expect(covered.run).toHaveBeenCalledTimes(2);

        // A head the branch list does not carry, such as a commit deployed under another ref, still gets its own query.
        const uncovered = dependencies();
        const { deployments: fallback } = await loadVercelDeployments(
            uncovered,
            contextFor('main', featureHead),
            '/project',
        );
        expect(fallback?.preview?.commit?.sha).toBe(featureHead);
        expect(uncovered.run).toHaveBeenCalledTimes(3);
    });

    it('does not substitute another production build for a missing merge commit', async () => {
        const { deployments } = await loadVercelDeployments(
            dependencies(),
            contextFor('feat/panel', featureHead),
            '/project',
            'c'.repeat(40),
        );
        expect(deployments?.production).toBeUndefined();
    });

    it('reports no production deployment for a branch that never triggered a production build', async () => {
        const { deployments } = await loadVercelDeployments(
            dependencies(),
            contextFor('feat/panel', featureHead),
            '/project',
        );

        // The default branch's live build is not this branch's: the Status row means "this shipped".
        expect(deployments?.production).toBeUndefined();
        expect(deployments?.preview).toMatchObject({
            environment: 'preview',
            hostname: 'widget-feature-preview.vercel.app',
            state: 'success',
        });
        expect(deployments?.branchDeployments).toHaveLength(1);
    });

    it('reports the production deployment the checked-out branch shipped', async () => {
        const { deployments } = await loadVercelDeployments(
            dependencies(),
            contextFor('main', defaultHead),
            '/project',
        );

        expect(deployments?.production).toMatchObject({
            environment: 'production',
            hostname: 'widget-default-production.vercel.app',
            state: 'success',
        });
    });
});

describe('Vercel project discovery', () => {
    /**
     * Two teams, and only `team-b` deploys `acme/widget`. Counts each kind of `vc` call so a test can assert what a
     * second lookup spent.
     */
    function discovery(options: { failTeams?: boolean } = {}) {
        let now = 0;
        const calls = { teams: 0, deployments: 0 };
        const run = vi.fn<VercelDependencies['run']>((arguments_) => {
            if (arguments_[0] === 'teams') {
                calls.teams += 1;
                if (options.failTeams) return Promise.reject(new Error('timed out'));
                return Promise.resolve(JSON.stringify([{ slug: 'team-a' }, { slug: 'team-b' }]));
            }
            calls.deployments += 1;
            const query = new URL(arguments_[1] ?? '', 'https://api.vercel.com').searchParams;
            const deployed =
                arguments_.includes('team-b') && query.get('meta-githubRepo') === 'widget';
            return Promise.resolve(JSON.stringify(deployed ? [{ name: 'widget' }] : []));
        });
        const dependencies: VercelDependencies = {
            links: new VercelLinkCache({ now: () => now }),
            onParseFailure: () => {},
            run,
        };
        return { advance: (ms: number) => (now += ms), calls, dependencies };
    }

    it('remembers an unlinked repository for half an hour instead of re-proving it each refresh', async () => {
        const { advance, calls, dependencies } = discovery();
        await expect(findVercelLink(dependencies, 'acme', 'docs')).resolves.toBeUndefined();
        expect(calls).toEqual({ teams: 1, deployments: 2 });

        advance(29 * 60_000);
        await expect(findVercelLink(dependencies, 'acme', 'docs')).resolves.toBeUndefined();
        expect(calls).toEqual({ teams: 1, deployments: 2 });

        advance(60_000);
        await findVercelLink(dependencies, 'acme', 'docs');
        expect(calls).toEqual({ teams: 2, deployments: 4 });
    });

    it('shares one team list across repositories and one discovery across concurrent readers', async () => {
        const { calls, dependencies } = discovery();
        const [first, second] = await Promise.all([
            findVercelLink(dependencies, 'acme', 'widget'),
            findVercelLink(dependencies, 'acme', 'widget'),
        ]);
        expect(first).toEqual({ team: 'team-b', project: 'widget' });
        expect(second).toBe(first);
        await findVercelLink(dependencies, 'acme', 'docs');
        expect(calls).toEqual({ teams: 1, deployments: 4 });
    });

    it('does not remember a failed team list as an absence', async () => {
        const { calls, dependencies } = discovery({ failTeams: true });
        await expect(findVercelLink(dependencies, 'acme', 'widget')).rejects.toThrow('timed out');
        await expect(findVercelLink(dependencies, 'acme', 'widget')).rejects.toThrow('timed out');
        expect(calls.teams).toBe(2);
    });
});
