import type { ProjectStatusRepository, ProjectStatusSummary } from 'caxri';
import { describe, expect, it } from 'vitest';

import { statusBadge } from '../status-badge';

function repo_(overrides: Partial<ProjectStatusRepository> = {}): ProjectStatusRepository {
    return {
        id: 'repo',
        name: 'Project',
        kind: 'primary',
        branch: 'feature',
        acceptances: [],
        linearIssues: [],
        errors: [],
        ...overrides,
    };
}

function summary(repositories: ProjectStatusRepository[]): ProjectStatusSummary {
    return { repositories, refreshedAt: 1 };
}

describe('Status tab badge', () => {
    it('hides an empty, unknown, or unavailable summary', () => {
        expect(statusBadge(undefined)).toBeUndefined();
        expect(statusBadge(summary([]))).toBeUndefined();
        expect(statusBadge({ ...summary([]), error: 'Unavailable' })).toBeUndefined();
    });

    it('counts failed check leaves and current deployments, without counting rollups or history', () => {
        const failedDeployment = {
            environment: 'preview' as const,
            hostname: 'preview.example.com',
            url: 'https://preview.example.com',
            state: 'failure' as const,
        };
        const repo = repo_({
            pullRequest: {
                number: 1,
                title: 'Feature',
                url: 'https://github.com/example/repo/pull/1',
                state: 'failure',
                hiddenCheckCount: 3,
                checks: [
                    { name: 'Build', state: 'failure', url: 'https://checks.example.com/run/1' },
                    { name: 'Types', state: 'failure', url: 'https://checks.example.com/run/1' },
                    { name: 'Test', state: 'success' },
                    { name: 'Lint', state: 'pending' },
                    { name: 'Superseded', state: 'cancelled' },
                ],
            },
            deployments: {
                url: 'https://example.com',
                branchDeployments: [{ ...failedDeployment, url: 'https://old.example.com' }],
                production: failedDeployment,
                preview: failedDeployment,
            },
        });
        expect(statusBadge(summary([repo, { ...repo, id: 'nested', kind: 'submodule' }]))).toEqual({
            kind: 'error',
            description: '2 failed checks, 1 failed deployment',
        });
    });

    it('includes independent submodule failures without capping the reported total', () => {
        const repos = Array.from({ length: 101 }, (_, index) =>
            repo_({
                id: String(index),
                kind: 'submodule',
                pullRequest: {
                    number: 1,
                    title: 'Feature',
                    url: `https://github.com/example/repo-${index}/pull/1`,
                    state: 'failure',
                    hiddenCheckCount: 0,
                    checks: [{ name: 'Build', state: 'failure' }],
                },
            }),
        );
        expect(statusBadge(summary(repos))).toEqual({
            kind: 'error',
            description: '101 failed checks',
        });
        const healthy = summary([repo_()]);
        expect(statusBadge(healthy)).toBeUndefined();
    });

    it('raises a count badge for unresolved review threads and folds them into a failure badge', () => {
        const pullRequest = {
            number: 1,
            title: 'Feature',
            url: 'https://github.com/example/repo/pull/1',
            state: 'success' as const,
            hiddenCheckCount: 0,
            checks: [],
            unresolvedReviewThreads: [
                {
                    url: 'https://github.com/example/repo/pull/1#discussion_r1',
                    body: 'Rename this',
                },
                { url: 'https://github.com/example/repo/pull/1#discussion_r2', body: 'Add a test' },
            ],
        };
        const threadsOnly = summary([repo_({ pullRequest })]);
        expect(statusBadge(threadsOnly)).toEqual({
            kind: 'count',
            count: 2,
            description: '2 unresolved comments',
        });
        const failing = repo_({
            pullRequest: {
                ...pullRequest,
                state: 'failure',
                checks: [{ name: 'Build', state: 'failure' }],
            },
        });
        expect(statusBadge(summary([failing]))).toEqual({
            kind: 'error',
            description: '1 failed check, 2 unresolved comments',
        });
    });
});
