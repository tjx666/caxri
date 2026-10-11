import { describe, expect, it } from 'vitest';

import type { GitHubPullRequestStore } from '../../external-status/index';
import type { VercelDeploymentStore } from '../index';
import {
    isSameCommit,
    pullRequestOrigin,
    resolveSessionDeployment,
} from '../session-pull-request-deployment';

const MERGE_COMMIT = '4f0c1d9a7b6e5f4d3c2b1a09876543210fedcba9';

function dependencies(options: {
    mergeCommit?: string | null;
    productionSha?: string;
    state?: 'success' | 'failure';
}) {
    return {
        github: {
            view: () =>
                Promise.resolve(
                    JSON.stringify({
                        number: 42,
                        mergeCommit:
                            options.mergeCommit === null
                                ? null
                                : { oid: options.mergeCommit ?? MERGE_COMMIT },
                    }),
                ),
        } as unknown as GitHubPullRequestStore,
        vercel: {
            production: () =>
                Promise.resolve(
                    options.productionSha
                        ? { commitSha: options.productionSha, state: options.state ?? 'success' }
                        : undefined,
                ),
        } as unknown as VercelDeploymentStore,
    };
}

const mergedPullRequest = {
    number: 42,
    title: 'fix: session delivery badge',
    url: 'https://github.com/yutengjing/caxri/pull/42',
    state: 'merged',
    source: 'agent',
} as const;

describe('Session deployment resolution', () => {
    it('reports the deployment only when production was built from this merge commit', async () => {
        await expect(
            resolveSessionDeployment(
                dependencies({ productionSha: MERGE_COMMIT }),
                mergedPullRequest,
                '/tmp/caxri',
            ),
        ).resolves.toEqual({ state: 'success' });
        /**
         * A later merge moves production to another commit. The row then describes a delivery that is no longer being
         * served, which is exactly the claim the badge must not make.
         */
        const otherCommit = dependencies({ productionSha: 'a'.repeat(40) });
        await expect(
            resolveSessionDeployment(otherCommit, mergedPullRequest, '/tmp/caxri'),
        ).resolves.toBeUndefined();
    });

    it('reports nothing for a pull request GitHub has not merged', async () => {
        await expect(
            resolveSessionDeployment(
                dependencies({ mergeCommit: null, productionSha: MERGE_COMMIT }),
                { ...mergedPullRequest, state: 'open' },
                '/tmp/caxri',
            ),
        ).resolves.toBeUndefined();
        await expect(
            resolveSessionDeployment(
                dependencies({ mergeCommit: null, productionSha: MERGE_COMMIT }),
                mergedPullRequest,
                '/tmp/caxri',
            ),
        ).resolves.toBeUndefined();
    });

    it('accepts an abbreviated commit as the same commit', () => {
        expect(isSameCommit(MERGE_COMMIT, MERGE_COMMIT.slice(0, 7).toUpperCase())).toBe(true);
        expect(isSameCommit(MERGE_COMMIT, MERGE_COMMIT.slice(0, 6))).toBe(false);
        expect(isSameCommit(MERGE_COMMIT, `${MERGE_COMMIT.slice(0, 39)}0`)).toBe(false);
    });

    it('reads the repository from the pull request URL', () => {
        expect(pullRequestOrigin('https://github.com/yutengjing/caxri/pull/42')).toEqual({
            number: 42,
            owner: 'yutengjing',
            repo: 'caxri',
        });
        expect(
            pullRequestOrigin('https://github.com/yutengjing/caxri/pull/42/files'),
        ).toMatchObject({ number: 42 });
        expect(pullRequestOrigin('https://example.com/yutengjing/caxri/pull/42')).toBeUndefined();
        expect(pullRequestOrigin('https://github.com/yutengjing/caxri/issues/42')).toBeUndefined();
    });
});
