import { describe, expect, it } from 'vitest';

import { evaluateCIExecutionPlan, SMOKE_E2E_SPEC } from '../ci-execution-plan';

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

    it('routes repository harness configuration and bridge changes through focused regressions', () => {
        for (const changedFiles of [
            ['.claude/settings.json', '.codex/hooks.json'],
            ['.agents/invocation.md'],
            ['CLAUDE.md'],
            ['.claude/skills'],
        ]) {
            expect(
                evaluateCIExecutionPlan({
                    changedFiles,
                    eventName: 'pull_request',
                    pullRequestDraft: false,
                }),
            ).toMatchObject({ checksScope: 'focused-harness', runE2E: false });
        }
    });

    it('uses focused source checks for drafts and affected tests for ready source pull requests', () => {
        const input = {
            changedFiles: ['apps/server/src/domains/index.ts'],
            eventName: 'pull_request',
        };

        expect(evaluateCIExecutionPlan({ ...input, pullRequestDraft: true })).toMatchObject({
            checksScope: 'focused-source',
            runE2E: false,
        });
        expect(
            evaluateCIExecutionPlan({
                ...input,
                affectedE2ETests: [
                    'e2e/terminal.e2e.ts',
                    'e2e/settings.e2e.ts',
                    'e2e/terminal.e2e.ts',
                ],
                pullRequestDraft: false,
            }),
        ).toMatchObject({
            checksScope: 'affected',
            e2eProfile: 'focused',
            e2eTests: ['e2e/settings.e2e.ts', 'e2e/terminal.e2e.ts'],
            runE2E: false,
        });
    });

    it('falls back to the launch smoke spec when no E2E spec is affected', () => {
        expect(
            evaluateCIExecutionPlan({
                changedFiles: ['apps/server/src/domains/index.ts'],
                eventName: 'pull_request',
                pullRequestDraft: false,
            }),
        ).toMatchObject({ checksScope: 'affected', e2eTests: [SMOKE_E2E_SPEC] });
    });

    it('falls back to full hosted checks for global configuration changes and failed E2E selection', () => {
        const input = {
            changedFiles: ['apps/server/src/domains/index.ts'],
            eventName: 'pull_request',
            pullRequestDraft: false,
        };

        expect(evaluateCIExecutionPlan({ ...input, hasFullValidationPath: true })).toMatchObject({
            checksScope: 'full',
            e2eProfile: 'optimized',
            runE2E: false,
        });
        expect(
            evaluateCIExecutionPlan({ ...input, affectedSelectionError: 'bad CI-E2E-Tests' }),
        ).toMatchObject({
            checksScope: 'full',
            e2eProfile: 'optimized',
            reason: 'affected E2E selection failed closed: bad CI-E2E-Tests',
            runE2E: false,
        });
    });

    it('fails closed to full checks without E2E for an unknown future event', () => {
        expect(evaluateCIExecutionPlan({ changedFiles: [], eventName: 'future_event' })).toEqual({
            checksScope: 'full',
            e2eProfile: 'control',
            reason: 'unknown event future_event; running full checks only',
            runE2E: false,
        });
    });

    it('does not let future Acceptance source files bypass the type boundary', () => {
        const input = {
            changedFiles: ['.agents/acceptance/helper.ts'],
            eventName: 'pull_request',
        };

        expect(evaluateCIExecutionPlan({ ...input, pullRequestDraft: true })).toMatchObject({
            checksScope: 'focused-source',
        });
        expect(evaluateCIExecutionPlan({ ...input, pullRequestDraft: false })).toMatchObject({
            checksScope: 'affected',
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

        expect(
            evaluateCIExecutionPlan({
                changedFiles: ['apps/server/src/domains/index.ts', '.agents/invocation.md'],
                eventName: 'pull_request',
                pullRequestDraft: false,
                reusableGreenRun: {
                    changedFiles: ['.agents/invocation.md'],
                    headSha: 'a'.repeat(40),
                    runId: 124,
                },
            }),
        ).toMatchObject({
            checksScope: 'focused-harness',
            reason: 'ancestor full-green run 124; repository-harness delta',
            runE2E: false,
        });
    });

    it('ignores an invalid reuse receipt and keeps affected ready-PR coverage', () => {
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
        ).toMatchObject({ checksScope: 'affected', runE2E: false });
    });

    it('runs source main push checks without E2E and skips duplicate gates for release commits', () => {
        expect(
            evaluateCIExecutionPlan({
                changedFiles: ['apps/desktop/src/main/index.ts'],
                eventName: 'push',
                isVerifiedReleaseCommit: false,
            }),
        ).toMatchObject({ checksScope: 'full', e2eProfile: 'optimized', runE2E: false });
        expect(
            evaluateCIExecutionPlan({
                changedFiles: ['package.json'],
                eventName: 'push',
                isVerifiedReleaseCommit: true,
            }),
        ).toMatchObject({ checksScope: 'skipped', e2eProfile: 'control', runE2E: false });
        expect(
            evaluateCIExecutionPlan({
                changedFiles: ['package.json', 'apps/desktop/src/main/index.ts'],
                eventName: 'push',
                isVerifiedReleaseCommit: false,
            }),
        ).toMatchObject({ checksScope: 'full', e2eProfile: 'optimized', runE2E: false });
    });

    it('keeps every automatic main push free of full E2E', () => {
        expect(
            evaluateCIExecutionPlan({
                changedFiles: ['docs/quality-toolchain.md', '.agents/skills/go/SKILL.md'],
                eventName: 'push',
                isVerifiedReleaseCommit: false,
            }),
        ).toMatchObject({ checksScope: 'full', e2eProfile: 'control', runE2E: false });
        expect(
            evaluateCIExecutionPlan({
                changedFiles: [],
                eventName: 'push',
                isVerifiedReleaseCommit: false,
            }),
        ).toMatchObject({ runE2E: false });
    });

    it('keeps legacy repair metadata on full hosted checks without starting E2E', () => {
        expect(
            evaluateCIExecutionPlan({
                changedFiles: ['e2e/session-attention.e2e.ts'],
                eventName: 'pull_request',
                pullRequestDraft: false,
                retryKind: 'spec-only',
                retryMode: 'e2e-repair',
            }),
        ).toEqual({
            checksScope: 'full',
            e2eProfile: 'control',
            reason: 'e2e-repair is compatibility metadata; explicit dispatch owns full E2E',
            runE2E: false,
        });
    });

    it('turns metadata-only retry trailers into full hosted checks', () => {
        expect(
            evaluateCIExecutionPlan({
                changedFiles: [],
                eventName: 'pull_request',
                pullRequestDraft: false,
                retryKind: 'metadata-only',
                retryMode: 'e2e-only',
            }),
        ).toMatchObject({
            checksScope: 'full',
            e2eProfile: 'control',
            reason: 'e2e-only is compatibility metadata; explicit dispatch owns full E2E',
            runE2E: false,
        });
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
            reason: 'explicit validation dispatch',
            runE2E: true,
        });
    });

    it('selects concurrent full checks only for an explicit optimized dispatch', () => {
        const inputs = [
            {
                changedFiles: ['package.json'],
                eventName: 'pull_request',
                hasFullValidationPath: true,
                pullRequestDraft: false,
            },
            {
                changedFiles: ['apps/desktop/src/main/index.ts'],
                eventName: 'push',
                isVerifiedReleaseCommit: false,
            },
            {
                changedFiles: [],
                dispatchE2EProfile: 'optimized' as const,
                eventName: 'workflow_dispatch',
            },
        ];

        for (const [index, input] of inputs.entries()) {
            const plan = evaluateCIExecutionPlan(input);
            expect(plan).toMatchObject({
                checksScope: 'full',
                e2eProfile: 'optimized',
                runE2E: index === inputs.length - 1,
            });
        }
    });
});
