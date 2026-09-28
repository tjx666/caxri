import { describe, expect, it, vi } from 'vitest';

import type { BranchPublicationContext } from '../branch';
import type { VercelDependencies } from '../vercel';
import { loadVercelDeployments } from '../vercel';

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

function dependencies(productionState = 'READY'): VercelDependencies {
    return {
        links: new Map([['acme/widget', link]]),
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
