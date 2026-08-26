import { describe, expect, it } from 'vitest';

import { evaluateCIExecutionPlan } from '../ci-execution-plan';

describe('CI execution plan', () => {
    it('keeps documentation pull requests focused without macOS E2E', () => {
        expect(
            evaluateCIExecutionPlan({
                changedFiles: ['docs/testing.md', 'README.md'],
                eventName: 'pull_request',
                pullRequestDraft: false,
            }),
        ).toMatchObject({ checksScope: 'focused-docs', runE2E: false });
    });

    it('runs repository-skill code through the focused skill gate without macOS E2E', () => {
        expect(
            evaluateCIExecutionPlan({
                changedFiles: [
                    '.agents/skills/switch-worktree/scripts/desktop-lease.ts',
                    '.agents/skills/switch-worktree/scripts/switch-worktree.test.ts',
                ],
                eventName: 'pull_request',
                pullRequestDraft: false,
            }),
        ).toMatchObject({ checksScope: 'focused-skills', runE2E: false });
    });

    it('routes skill Markdown through skill regressions instead of the generic docs gate', () => {
        expect(
            evaluateCIExecutionPlan({
                changedFiles: ['.agents/skills/e2e-testing/SKILL.md'],
                eventName: 'pull_request',
                pullRequestDraft: false,
            }),
        ).toMatchObject({ checksScope: 'focused-skills', runE2E: false });
    });

    it('uses focused source checks for drafts and full gates for ready source pull requests', () => {
        const input = {
            changedFiles: ['apps/server/src/domains/index.ts'],
            eventName: 'pull_request',
        };

        expect(evaluateCIExecutionPlan({ ...input, pullRequestDraft: true })).toMatchObject({
            checksScope: 'focused-source',
            runE2E: false,
        });
        expect(evaluateCIExecutionPlan({ ...input, pullRequestDraft: false })).toMatchObject({
            checksScope: 'full',
            e2eProfile: 'optimized',
            runE2E: true,
        });
    });

    it('checks only a safe incremental delta after a validated ancestor full-green run', () => {
        expect(
            evaluateCIExecutionPlan({
                changedFiles: [
                    'apps/server/src/domains/index.ts',
                    '.agents/skills/go/scripts/state.ts',
                ],
                eventName: 'pull_request',
                pullRequestDraft: false,
                reusableGreenRun: {
                    changedFiles: ['.agents/skills/go/scripts/state.ts'],
                    headSha: 'a'.repeat(40),
                    runId: 123,
                },
            }),
        ).toEqual({
            checksScope: 'focused-skills',
            e2eProfile: 'control',
            reason: 'ancestor full-green run 123; repository-skill delta',
            runE2E: false,
        });
    });

    it('ignores an invalid reuse receipt and keeps full ready-PR coverage', () => {
        expect(
            evaluateCIExecutionPlan({
                changedFiles: ['apps/server/src/domains/index.ts'],
                eventName: 'pull_request',
                pullRequestDraft: false,
                reusableGreenRun: {
                    changedFiles: ['apps/server/src/domains/index.ts'],
                    headSha: 'a'.repeat(40),
                    runId: 123,
                },
            }),
        ).toMatchObject({ checksScope: 'full', runE2E: true });
    });

    it('runs source main pushes with optimized E2E and release commits with the control suite', () => {
        expect(
            evaluateCIExecutionPlan({
                changedFiles: ['apps/desktop/src/main/index.ts'],
                eventName: 'push',
                isReleaseCommit: false,
            }),
        ).toMatchObject({ checksScope: 'full', e2eProfile: 'optimized', runE2E: true });
        expect(
            evaluateCIExecutionPlan({
                changedFiles: ['package.json'],
                eventName: 'push',
                isReleaseCommit: true,
            }),
        ).toMatchObject({ checksScope: 'full', e2eProfile: 'control', runE2E: true });
    });

    it('skips E2E only for documentation or skill-only main pushes and fails closed on empty deltas', () => {
        expect(
            evaluateCIExecutionPlan({
                changedFiles: ['docs/quality-toolchain.md', '.agents/skills/go/SKILL.md'],
                eventName: 'push',
                isReleaseCommit: false,
            }),
        ).toMatchObject({ checksScope: 'full', e2eProfile: 'control', runE2E: false });
        expect(
            evaluateCIExecutionPlan({
                changedFiles: [],
                eventName: 'push',
                isReleaseCommit: false,
            }),
        ).toMatchObject({ runE2E: true });
    });

    it('keeps eligible retry modes on macOS while skipping Linux checks', () => {
        expect(
            evaluateCIExecutionPlan({
                changedFiles: ['apps/server/src/domains/index.ts'],
                eventName: 'pull_request',
                pullRequestDraft: false,
                retryMode: 'e2e-repair',
            }),
        ).toMatchObject({ checksScope: 'skipped', runE2E: true });
    });

    it('uses workflow dispatch to compare the same manifest under control and optimized profiles', () => {
        expect(
            evaluateCIExecutionPlan({
                changedFiles: [],
                dispatchE2EProfile: 'optimized',
                eventName: 'workflow_dispatch',
            }),
        ).toEqual({
            checksScope: 'full',
            e2eProfile: 'optimized',
            reason: 'self-hosted performance dispatch',
            runE2E: true,
        });
    });

    it('never selects concurrent full checks without the E2E job that owns them', () => {
        const inputs = [
            {
                changedFiles: ['apps/server/src/domains/index.ts'],
                eventName: 'pull_request',
                pullRequestDraft: false,
            },
            {
                changedFiles: ['apps/desktop/src/main/index.ts'],
                eventName: 'push',
                isReleaseCommit: false,
            },
            {
                changedFiles: [],
                dispatchE2EProfile: 'optimized' as const,
                eventName: 'workflow_dispatch',
            },
        ];

        for (const input of inputs) {
            const plan = evaluateCIExecutionPlan(input);
            expect(plan).toMatchObject({
                checksScope: 'full',
                e2eProfile: 'optimized',
                runE2E: true,
            });
        }
    });
});
