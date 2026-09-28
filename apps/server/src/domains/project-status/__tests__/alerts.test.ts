import type {
    ProjectStatusCheck,
    ProjectStatusDeployment,
    ProjectStatusRepository,
    ProjectStatusSummary,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { ProjectStatusAlertTracker } from '../alerts';

function repo(overrides: Partial<ProjectStatusRepository> = {}): ProjectStatusRepository {
    return {
        id: 'repo-1',
        kind: 'primary',
        name: 'caxri',
        rootPath: '/Users/me/code/caxri',
        branch: 'feat/example',
        githubUrl: 'https://github.com/tjx666/caxri',
        acceptances: [],
        linearIssues: [],
        errors: [],
        ...overrides,
    };
}

function withChecks(...checks: ProjectStatusCheck[]): ProjectStatusRepository {
    return repo({
        pullRequest: {
            number: 7,
            title: 'Example',
            url: 'https://github.com/tjx666/caxri/pull/7',
            state: 'failure',
            checks,
            hiddenCheckCount: 0,
        },
    });
}

/**
 * One snapshot whose only pull request carries `checks`.
 */
function checksSnapshot(...checks: ProjectStatusCheck[]): ProjectStatusSummary {
    return { repositories: [withChecks(...checks)], refreshedAt: 1 };
}

/**
 * One snapshot whose only repository has a current preview deployment.
 */
function previewSnapshot(
    deployment: Partial<ProjectStatusDeployment> = {},
    branchDeployments: ProjectStatusDeployment[] = [],
): ProjectStatusSummary {
    const repo_ = repo({
        deployments: {
            url: 'https://vercel.com/tjx666/caxri',
            branchDeployments,
            preview: {
                environment: 'preview',
                hostname: 'caxri-abc.vercel.app',
                state: 'failure',
                url: 'https://caxri-abc.vercel.app',
                inspectorUrl: 'https://vercel.com/tjx666/caxri/abc',
                ...deployment,
            },
        },
    });
    return { repositories: [repo_], refreshedAt: 1 };
}

describe('ProjectStatusAlertTracker', () => {
    it('does not alert when a running check is cancelled', () => {
        const tracker = new ProjectStatusAlertTracker();
        tracker.observe(checksSnapshot({ name: 'build', state: 'pending' }));
        expect(tracker.observe(checksSnapshot({ name: 'build', state: 'cancelled' }))).toEqual([]);
    });
    it('stays silent on the first observation, even when the check is already failing', () => {
        const tracker = new ProjectStatusAlertTracker();
        expect(tracker.observe(checksSnapshot({ name: 'build', state: 'failure' }))).toEqual([]);
    });

    it('alerts when a passing check turns into a failure', () => {
        const tracker = new ProjectStatusAlertTracker();
        tracker.observe(checksSnapshot({ name: 'build', state: 'success' }));
        expect(tracker.observe(checksSnapshot({ name: 'build', state: 'failure' }))).toEqual([
            {
                kind: 'check',
                repository: 'caxri',
                branch: 'feat/example',
                name: 'build',
                url: 'https://github.com/tjx666/caxri/pull/7',
            },
        ]);
    });

    it('prefers the check URL over the pull request URL when GitHub reports one', () => {
        const tracker = new ProjectStatusAlertTracker();
        const url = 'https://github.com/tjx666/caxri/actions/runs/1';
        tracker.observe(checksSnapshot({ name: 'build', state: 'pending', url }));
        const alerts = tracker.observe(checksSnapshot({ name: 'build', state: 'failure', url }));
        expect(alerts[0]?.url).toBe(url);
    });

    it('does not repeat an alert while the same failure persists', () => {
        const tracker = new ProjectStatusAlertTracker();
        tracker.observe(checksSnapshot({ name: 'build', state: 'success' }));
        tracker.observe(checksSnapshot({ name: 'build', state: 'failure' }));
        expect(tracker.observe(checksSnapshot({ name: 'build', state: 'failure' }))).toEqual([]);
    });

    it('alerts again after the check recovers and fails a second time', () => {
        const tracker = new ProjectStatusAlertTracker();
        tracker.observe(checksSnapshot({ name: 'build', state: 'failure' }));
        tracker.observe(checksSnapshot({ name: 'build', state: 'success' }));
        expect(tracker.observe(checksSnapshot({ name: 'build', state: 'failure' }))).toHaveLength(
            1,
        );
    });

    it('reports every check that starts failing in the same snapshot', () => {
        const tracker = new ProjectStatusAlertTracker();
        tracker.observe(
            checksSnapshot({ name: 'build', state: 'pending' }, { name: 'lint', state: 'pending' }),
        );
        const alerts = tracker.observe(
            checksSnapshot({ name: 'build', state: 'failure' }, { name: 'lint', state: 'failure' }),
        );
        expect(alerts.map((alert) => alert.name)).toEqual(['build', 'lint']);
    });

    it('alerts on a Vercel deployment failure with its inspector URL', () => {
        const tracker = new ProjectStatusAlertTracker();
        tracker.observe(previewSnapshot({ state: 'pending' }));
        expect(tracker.observe(previewSnapshot({ state: 'failure' }))).toEqual([
            {
                kind: 'deployment',
                repository: 'caxri',
                branch: 'feat/example',
                name: 'preview',
                url: 'https://vercel.com/tjx666/caxri/abc',
            },
        ]);
    });

    it('alerts for a new failing deployment even though the previous one also failed', () => {
        const tracker = new ProjectStatusAlertTracker();
        tracker.observe(previewSnapshot({ state: 'pending' }));
        tracker.observe(previewSnapshot({ state: 'failure' }));
        const alerts = tracker.observe(previewSnapshot({ hostname: 'caxri-def.vercel.app' }));
        expect(alerts).toHaveLength(1);
    });

    it('ignores the rolling branch deployment history, which only replays known outcomes', () => {
        const tracker = new ProjectStatusAlertTracker();
        const historical: ProjectStatusDeployment = {
            environment: 'preview',
            hostname: 'caxri-old.vercel.app',
            state: 'failure',
            url: 'https://caxri-old.vercel.app',
        };
        tracker.observe(previewSnapshot({ state: 'success' }, [historical]));
        expect(tracker.observe(previewSnapshot({ state: 'success' }, [historical]))).toEqual([]);
    });

    it('keys on the GitHub repository, so two Sessions on one branch alert once', () => {
        const tracker = new ProjectStatusAlertTracker();
        const worktree: ProjectStatusSummary = {
            repositories: [
                {
                    ...withChecks({ name: 'build', state: 'failure' }),
                    id: 'repo-2',
                    kind: 'worktree',
                    rootPath: '/Users/me/code/caxri-worktrees/example',
                },
            ],
            refreshedAt: 1,
        };
        tracker.observe(checksSnapshot({ name: 'build', state: 'success' }));
        expect(tracker.observe(worktree)).toHaveLength(1);
        expect(tracker.observe(checksSnapshot({ name: 'build', state: 'failure' }))).toEqual([]);
    });
    describe('an item seen for the first time', () => {
        const startedAt = 10_000_000;

        it('alerts when the failure happened after the tracker started', () => {
            let now = startedAt;
            const tracker = new ProjectStatusAlertTracker({ now: () => now });
            now += 60_000;
            expect(
                tracker.observe(
                    checksSnapshot({ name: 'build', state: 'failure', completedAt: startedAt + 1 }),
                ),
            ).toHaveLength(1);
        });

        it('stays silent when the failure predates the tracker', () => {
            let now = startedAt;
            const tracker = new ProjectStatusAlertTracker({ now: () => now });
            now += 60_000;
            expect(
                tracker.observe(
                    checksSnapshot({ name: 'build', state: 'failure', completedAt: startedAt - 1 }),
                ),
            ).toEqual([]);
        });

        it('stays silent when the failure is older than the first-seen window', () => {
            let now = startedAt;
            const tracker = new ProjectStatusAlertTracker({ now: () => now });
            now += 2 * 60 * 60_000;
            expect(
                tracker.observe(
                    checksSnapshot({ name: 'build', state: 'failure', completedAt: startedAt + 1 }),
                ),
            ).toEqual([]);
        });

        it('alerts on a new preview build that failed between two polls', () => {
            let now = startedAt;
            const tracker = new ProjectStatusAlertTracker({ now: () => now });
            now += 60_000;
            expect(tracker.observe(previewSnapshot({ createdAt: startedAt + 1_000 }))).toHaveLength(
                1,
            );
        });
    });

    it('notifies a production failure once even when two branches resolve to it', () => {
        let now = 10_000_000;
        const tracker = new ProjectStatusAlertTracker({ now: () => now });
        now += 60_000;
        const production = (branch: string): ProjectStatusSummary => ({
            refreshedAt: 1,
            repositories: [
                repo({
                    branch,
                    deployments: {
                        url: 'https://vercel.com/tjx666/caxri',
                        branchDeployments: [],
                        production: {
                            environment: 'production',
                            hostname: 'caxri-prod.vercel.app',
                            state: 'failure',
                            url: 'https://caxri-prod.vercel.app',
                            createdAt: now - 1_000,
                        },
                    },
                }),
            ],
        });
        expect(tracker.observe(production('main'))).toHaveLength(1);
        expect(tracker.observe(production('feat/merged'))).toEqual([]);
    });
});
