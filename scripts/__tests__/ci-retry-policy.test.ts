import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
    isFullValidationPath,
    isProtectedRetryPath,
    parsePullRequestE2ETests,
    selectAffectedE2ETests,
} from '../ci-path-policy';
import type { RetryPolicyInput } from '../ci-retry-policy';
import {
    evaluateRetryPolicy,
    extractBaseRunIdentity,
    extractGreenRunEvidence,
    greenReuseDiffArguments,
    parseRetryHint,
    retryAddedOrDeletedDiffArguments,
    retryDiffArguments,
    summarizeE2EJobs,
} from '../ci-retry-policy';

const tree = 'a'.repeat(40);
const baseTree = 'b'.repeat(40);
const eligible: RetryPolicyInput = {
    addedOrDeletedFiles: [],
    baseRun: {
        baseSha: 'base',
        checksConclusion: 'success',
        e2eConclusion: 'failure',
        e2eFailurePool: 'control',
        event: 'pull_request',
        headSha: 'old',
        pullRequestNumber: 17,
        repository: 'tjx666/caxri',
        workflowPath: '.github/workflows/ci.yml',
    },
    baseRunChangedFiles: ['apps/server/src/domains/base.ts'],
    baseRunTree: baseTree,
    changedFiles: ['e2e/session-attention.e2e.ts'],
    currentTree: tree,
    eventName: 'pull_request',
    hint: {
        baseRunId: 123,
        e2eTests: ['e2e/session-attention.e2e.ts'],
        mode: 'e2e-repair',
    },
    isAncestor: true,
    pullRequestBaseSha: 'base',
    pullRequestNumber: 17,
    repository: 'tjx666/caxri',
    workflowPath: '.github/workflows/ci.yml',
};

describe('CI retry policy', () => {
    it('parses the failed run pointer and optional focused repair specs', () => {
        expect(parseRetryHint(`retry\n\nCI-Mode: e2e-only\nCI-Base-Run: 123`)).toEqual({
            hint: { baseRunId: 123, mode: 'e2e-only' },
        });
        expect(parseRetryHint('ordinary commit')).toEqual({});
        expect(parseRetryHint('CI-Mode: e2e-only')).toEqual({
            error: 'CI-Base-Run must be numeric',
        });
        expect(parseRetryHint('CI-Mode: e2e-repair\nCI-Base-Run: 123')).toEqual({
            hint: { baseRunId: 123, mode: 'e2e-repair' },
        });
        expect(
            parseRetryHint(
                'repair\n\nCI-Mode: e2e-repair\nCI-Base-Run: 123\nCI-E2E-Tests: ["e2e/files.e2e.ts"]',
            ),
        ).toEqual({
            hint: {
                baseRunId: 123,
                e2eTests: ['e2e/files.e2e.ts'],
                mode: 'e2e-repair',
            },
        });
        expect(
            parseRetryHint(
                'repair\n\nCI-Mode: e2e-repair\nCI-Base-Run: 123\nCI-E2E-Tests: ["e2e/renderer.performance.e2e.ts"]',
            ),
        ).toEqual({
            error: 'Renderer performance requires the profiling CI gate, not e2e-repair',
        });
    });

    it('admits only a modified existing E2E spec after successful checks and one failed pool', () => {
        expect(evaluateRetryPolicy(eligible)).toMatchObject({
            e2eTests: ['e2e/session-attention.e2e.ts'],
            mode: 'e2e-repair',
            retryKind: 'spec-only',
        });
        for (const input of [
            { ...eligible, eventName: 'push' },
            { ...eligible, isAncestor: false },
            { ...eligible, pullRequestBaseSha: 'changed' },
            { ...eligible, workflowPath: '.github/workflows/other.yml' },
            {
                ...eligible,
                baseRun: { ...eligible.baseRun!, checksConclusion: 'failure' },
            },
            { ...eligible, changedFiles: ['pnpm-lock.yaml'] },
            { ...eligible, changedFiles: ['apps/server/src/domains/index.ts'] },
            { ...eligible, addedOrDeletedFiles: ['e2e/session-attention.e2e.ts'] },
            { ...eligible, baseRunChangedFiles: ['.github/workflows/ci.yml'] },
        ]) {
            expect(evaluateRetryPolicy(input).mode).toBe('full');
        }
    });

    it('admits e2e-only only when the base run tree is unchanged', () => {
        const metadataOnly: RetryPolicyInput = {
            ...eligible,
            changedFiles: [],
            currentTree: baseTree,
            hint: { baseRunId: 123, mode: 'e2e-only' },
        };
        expect(evaluateRetryPolicy(metadataOnly)).toMatchObject({
            mode: 'e2e-only',
            retryKind: 'metadata-only',
        });
        expect(evaluateRetryPolicy({ ...metadataOnly, currentTree: tree })).toMatchObject({
            mode: 'full',
        });
        expect(
            evaluateRetryPolicy({
                ...metadataOnly,
                changedFiles: ['e2e/session-attention.e2e.ts'],
            }),
        ).toMatchObject({ mode: 'full' });
    });

    it('always includes every changed spec in the focused repair set', () => {
        expect(
            evaluateRetryPolicy({
                ...eligible,
                changedFiles: ['e2e/session-attention.e2e.ts', 'e2e/session-pull-request.e2e.ts'],
                hint: {
                    baseRunId: 123,
                    e2eTests: ['e2e/session-attention.e2e.ts'],
                    mode: 'e2e-repair',
                },
            }),
        ).toMatchObject({
            e2eTests: ['e2e/session-attention.e2e.ts', 'e2e/session-pull-request.e2e.ts'],
        });
    });

    it('does not admit a protected spec through the optional focused list', () => {
        for (const spec of [
            'e2e/failure-isolation.e2e.ts',
            'e2e/editor.performance.e2e.ts',
            'e2e/mobile-acceptance-scenarios.e2e.ts',
            'e2e/mobile-pairing-desktop-acceptance.e2e.ts',
            'e2e/real-agent-smoke.e2e.ts',
            'e2e/renderer.performance.e2e.ts',
            'e2e/startup.performance.e2e.ts',
        ]) {
            expect(
                evaluateRetryPolicy({
                    ...eligible,
                    hint: {
                        baseRunId: 123,
                        e2eTests: [spec],
                        mode: 'e2e-repair',
                    },
                }),
                spec,
            ).toMatchObject({ mode: 'full' });
        }
    });

    it('recovers exact PR identity from server-expanded job metadata', () => {
        expect(
            extractBaseRunIdentity(
                [],
                [{ name: `retry-policy / pr-17 / base-${'b'.repeat(40)}` }, { name: 'checks' }],
            ),
        ).toEqual({ baseSha: 'b'.repeat(40), pullRequestNumber: 17 });
        expect(extractBaseRunIdentity([], [{ name: 'retry-policy' }])).toEqual({});
        expect(
            evaluateRetryPolicy({
                ...eligible,
                baseRun: { ...eligible.baseRun!, baseSha: undefined, pullRequestNumber: undefined },
            }).mode,
        ).toBe('full');
    });

    it('aggregates legacy, split, and single-machine E2E jobs while preserving one failed pool', () => {
        expect(summarizeE2EJobs([{ name: 'e2e', conclusion: 'failure' }])).toEqual({
            e2eConclusion: 'failure',
            e2eFailurePool: undefined,
        });
        expect(
            summarizeE2EJobs([
                {
                    name: 'e2e / parallel-safe',
                    conclusion: 'failure',
                    steps: [{ conclusion: 'failure', name: 'Run parallel-safe pool' }],
                },
                { name: 'e2e / desktop-exclusive', conclusion: 'success' },
            ]),
        ).toEqual({ e2eConclusion: 'failure', e2eFailurePool: 'parallel-safe' });
        expect(
            summarizeE2EJobs([
                { name: 'e2e / parallel-safe', conclusion: 'success' },
                { name: 'e2e / desktop-exclusive', conclusion: 'success' },
            ]),
        ).toEqual({ e2eConclusion: 'success', e2eFailurePool: undefined });
        expect(
            summarizeE2EJobs([
                { name: 'e2e / parallel-safe', conclusion: 'failure' },
                { name: 'e2e / desktop-exclusive', conclusion: 'failure' },
            ]),
        ).toEqual({ e2eConclusion: 'failure', e2eFailurePool: undefined });
        expect(
            summarizeE2EJobs([
                {
                    conclusion: 'failure',
                    name: 'e2e',
                    steps: [
                        { conclusion: 'failure', name: 'Run parallel-safe pool' },
                        { conclusion: 'success', name: 'Run desktop-exclusive pool' },
                        { conclusion: 'failure', name: 'Verify E2E auxiliary contracts' },
                    ],
                },
            ]),
        ).toEqual({ e2eConclusion: 'failure', e2eFailurePool: undefined });
        expect(
            summarizeE2EJobs([
                {
                    name: 'e2e / parallel-safe',
                    conclusion: 'failure',
                    steps: [{ conclusion: 'failure', name: 'Build Electron bundles' }],
                },
                { name: 'e2e / desktop-exclusive', conclusion: 'success' },
            ]),
        ).toEqual({ e2eConclusion: 'failure', e2eFailurePool: undefined });
        expect(
            summarizeE2EJobs([
                {
                    name: 'e2e',
                    conclusion: 'failure',
                    steps: [
                        { conclusion: 'failure', name: 'Run parallel-safe pool' },
                        { conclusion: 'cancelled', name: 'Run desktop-exclusive pool' },
                    ],
                },
            ]),
        ).toEqual({ e2eConclusion: 'failure', e2eFailurePool: undefined });
        expect(
            summarizeE2EJobs([
                {
                    name: 'e2e / parallel-safe',
                    conclusion: 'failure',
                    steps: [{ conclusion: 'failure', name: 'Run parallel-safe pool' }],
                },
                { name: 'e2e / desktop-exclusive', conclusion: 'cancelled' },
            ]),
        ).toEqual({ e2eConclusion: undefined, e2eFailurePool: undefined });
        expect(
            summarizeE2EJobs([
                {
                    conclusion: 'failure',
                    name: 'e2e',
                    steps: [
                        { conclusion: 'failure', name: 'Run parallel-safe pool' },
                        { conclusion: 'success', name: 'Run desktop-exclusive pool' },
                        { conclusion: 'skipped', name: 'Verify E2E auxiliary contracts' },
                    ],
                },
            ]),
        ).toEqual({ e2eConclusion: 'failure', e2eFailurePool: undefined });
        expect(
            summarizeE2EJobs([
                {
                    conclusion: 'failure',
                    name: 'e2e',
                    steps: [
                        { conclusion: 'failure', name: 'Run parallel-safe pool' },
                        { conclusion: 'success', name: 'Run desktop-exclusive pool' },
                        { conclusion: 'success', name: 'Verify E2E auxiliary contracts' },
                    ],
                },
            ]),
        ).toEqual({ e2eConclusion: 'failure', e2eFailurePool: 'parallel-safe' });
        expect(
            summarizeE2EJobs([
                {
                    conclusion: 'failure',
                    name: 'e2e',
                    steps: [
                        { conclusion: 'failure', name: 'Run parallel-safe pool' },
                        { conclusion: 'failure', name: 'Run desktop-exclusive pool' },
                    ],
                },
            ]),
        ).toEqual({ e2eConclusion: 'failure', e2eFailurePool: undefined });
    });

    it('fails closed when a modern single E2E job does not isolate one failed logical pool', () => {
        expect(
            evaluateRetryPolicy({
                ...eligible,
                baseRun: {
                    ...eligible.baseRun!,
                    e2eFailurePool: undefined,
                },
            }).mode,
        ).toBe('full');
    });

    it('extracts an auditable full-green candidate from workflow run jobs', () => {
        expect(
            extractGreenRunEvidence(
                {
                    conclusion: 'success',
                    event: 'pull_request',
                    head_sha: 'a'.repeat(40),
                    id: 456,
                    path: '.github/workflows/ci.yml',
                    pull_requests: [],
                    repository: { full_name: 'tjx666/caxri' },
                },
                [
                    {
                        conclusion: 'success',
                        name: `retry-policy / pr-17 / base-${'b'.repeat(40)}`,
                    },
                    {
                        conclusion: 'success',
                        name: 'checks',
                        steps: [{ conclusion: 'success', name: 'Run full platform checks' }],
                    },
                    { conclusion: 'success', name: 'e2e / parallel-safe' },
                    { conclusion: 'success', name: 'e2e / desktop-exclusive' },
                    { conclusion: 'success', name: 'CI gate' },
                ],
            ),
        ).toEqual({
            baseSha: 'b'.repeat(40),
            checksConclusion: 'success',
            e2eConclusion: 'success',
            event: 'pull_request',
            fullChecksConclusion: 'success',
            gateConclusion: 'success',
            headSha: 'a'.repeat(40),
            id: 456,
            pullRequestNumber: 17,
            repository: 'tjx666/caxri',
            runConclusion: 'success',
            workflowPath: '.github/workflows/ci.yml',
        });
    });

    it('uses the concurrent synthetic-merge receipt when standalone checks are skipped', () => {
        expect(
            extractGreenRunEvidence(
                {
                    conclusion: 'success',
                    event: 'pull_request',
                    head_sha: 'a'.repeat(40),
                    id: 789,
                    path: '.github/workflows/ci.yml',
                    pull_requests: [],
                    repository: { full_name: 'tjx666/caxri' },
                },
                [
                    {
                        conclusion: 'success',
                        name: `retry-policy / pr-17 / base-${'b'.repeat(40)}`,
                    },
                    { conclusion: 'skipped', name: 'checks' },
                    {
                        conclusion: 'success',
                        name: 'e2e',
                        steps: [
                            { conclusion: 'success', name: 'Verify full platform checks' },
                            { conclusion: 'success', name: 'Run parallel-safe pool' },
                            { conclusion: 'success', name: 'Run desktop-exclusive pool' },
                        ],
                    },
                    { conclusion: 'success', name: 'CI gate' },
                ],
            ),
        ).toMatchObject({
            checksConclusion: 'success',
            e2eConclusion: 'success',
            fullChecksConclusion: 'success',
        });
    });

    it('does not hide an explicit standalone checks failure behind a concurrent receipt', () => {
        expect(
            extractGreenRunEvidence(
                {
                    conclusion: 'failure',
                    event: 'pull_request',
                    head_sha: 'a'.repeat(40),
                    id: 790,
                    path: '.github/workflows/ci.yml',
                    pull_requests: [],
                    repository: { full_name: 'tjx666/caxri' },
                },
                [
                    { conclusion: 'failure', name: 'checks' },
                    {
                        conclusion: 'success',
                        name: 'e2e',
                        steps: [{ conclusion: 'success', name: 'Verify full platform checks' }],
                    },
                ],
            ),
        ).toMatchObject({ checksConclusion: 'failure', fullChecksConclusion: undefined });
    });

    it('disables rename detection for retry and green-reuse diffs', () => {
        expect(greenReuseDiffArguments('ancestor', 'current')).toEqual([
            'diff',
            '--no-renames',
            '--name-only',
            '-z',
            'ancestor...current',
        ]);
        expect(retryDiffArguments('ancestor', 'current')).toEqual(
            greenReuseDiffArguments('ancestor', 'current'),
        );
        expect(retryAddedOrDeletedDiffArguments('ancestor', 'current')).toEqual([
            'diff',
            '--no-renames',
            '--diff-filter=AD',
            '--name-only',
            '-z',
            'ancestor...current',
        ]);
    });

    it('fails malformed or unverifiable hints back to full CI', () => {
        expect(evaluateRetryPolicy({ ...eligible, hint: undefined, hintError: 'bad' })).toEqual({
            mode: 'full',
            reason: 'invalid retry hint: bad',
        });
        expect(evaluateRetryPolicy({ ...eligible, baseRun: undefined }).mode).toBe('full');
    });

    it('protects workflow, dependency, test, Electron, and release configuration', () => {
        for (const path of [
            '.github/workflows/ci.yml',
            '.github/actions/setup-caxri-job/action.yml',
            '.bun-version',
            'mise.toml',
            'package.json',
            'pnpm-lock.yaml',
            'pnpm-workspace.yaml',
            'vitest.config.ts',
            'playwright.config.ts',
            'electron.vite.config.ts',
            'tsconfig.node.json',
            '.agents/skills/release/SKILL.md',
            '.agents/skills/e2e-testing/SKILL.md',
            '.agents/skills/quality-check/scripts/check.ts',
            '.agents/skills/switch-worktree/scripts/desktop-lease.ts',
            'e2e/support/pools.ts',
            'e2e/support/worker-isolation.ts',
            'e2e/support/fixtures.ts',
            'e2e/support/helpers.ts',
            'scripts/ci-checks-worktree.ts',
            'scripts/ci-checks-worktree-setup.ts',
            'scripts/ci-concurrent-validation.ts',
            'scripts/ci-concurrent-validation-report.ts',
            'scripts/ci-execution-plan.ts',
            'scripts/ci-green-reuse.ts',
            'scripts/ci-metrics.ts',
            'scripts/ci-platform-checks.ts',
            'scripts/ci-platform-gates.ts',
            'scripts/ci-retry-policy.ts',
            'scripts/report-e2e-manifest.ts',
            'scripts/reporters/e2e-receipt-reporter.ts',
            'scripts/run-ci-focused-checks.ts',
            'scripts/run-e2e-failure-isolation.ts',
            'scripts/run-e2e-pools.ts',
            'scripts/run-e2e-repair.ts',
            'scripts/run-e2e-census-fixture.ts',
            'scripts/fixtures/playwright-census.config.ts',
            'scripts/fixtures/e2e-census.fixture.ts',
            'scripts/run-ci-parity.ts',
            'scripts/self-hosted-runner.ts',
            'e2e/editor.performance.e2e.ts',
            'e2e/failure-isolation.e2e.ts',
            'e2e/mobile-acceptance-scenarios.e2e.ts',
            'e2e/mobile-pairing-desktop-acceptance.e2e.ts',
            'e2e/real-agent-smoke.e2e.ts',
            'e2e/renderer.performance.e2e.ts',
            'e2e/startup.performance.e2e.ts',
            'RELEASING.md',
        ]) {
            expect(isProtectedRetryPath(path), path).toBe(true);
        }
        expect(isProtectedRetryPath('apps/server/src/domains/index.ts')).toBe(false);
    });

    it('protects every scripts/*.ts entrypoint the CI workflow actually executes', async () => {
        const workflow = await readFile(
            new URL('../../.github/workflows/ci.yml', import.meta.url),
            'utf8',
        );
        const executedScripts = [...new Set(workflow.match(/scripts\/[\w./-]+\.ts/gu))];
        expect(executedScripts.length).toBeGreaterThan(0);
        for (const script of executedScripts) {
            expect(isProtectedRetryPath(script), script).toBe(true);
        }
    });

    it('keeps dependency, toolchain, and workspace configuration changes on the full suite', () => {
        for (const path of [
            'package.json',
            'apps/desktop/package.json',
            'packages/protocol/tsconfig.json',
            'apps/server/vitest.config.ts',
            'patches/xterm.patch',
            'pnpm-lock.yaml',
            '.github/workflows/ci.yml',
            'e2e/support/electron-app.ts',
        ]) {
            expect(isFullValidationPath(path), path).toBe(true);
        }
        expect(isFullValidationPath('apps/server/src/domains/index.ts')).toBe(false);
        expect(isFullValidationPath('e2e/terminal.e2e.ts')).toBe(false);
    });

    it('reads declared E2E specs from the pull-request body and rejects protected or malformed entries', () => {
        expect(parsePullRequestE2ETests(undefined)).toEqual([]);
        expect(parsePullRequestE2ETests('## Summary\n\nNo specs declared.')).toEqual([]);
        expect(
            parsePullRequestE2ETests(
                '## Validation\n\nCI-E2E-Tests: ["e2e/settings.e2e.ts", "e2e/settings.e2e.ts"]\n',
            ),
        ).toEqual(['e2e/settings.e2e.ts']);
        expect(() =>
            parsePullRequestE2ETests('CI-E2E-Tests: ["e2e/real-agent-smoke.e2e.ts"]'),
        ).toThrow('ordinary E2E spec paths');
        expect(() => parsePullRequestE2ETests('CI-E2E-Tests: e2e/settings.e2e.ts')).toThrow();
    });

    it('unions declared, changed, and related specs that still exist', () => {
        expect(
            selectAffectedE2ETests({
                changedFiles: [
                    'apps/server/src/index.ts',
                    'e2e/terminal.e2e.ts',
                    'e2e/removed.e2e.ts',
                ],
                declared: ['e2e/settings.e2e.ts'],
                existingSpecs: new Set([
                    'e2e/files.e2e.ts',
                    'e2e/settings.e2e.ts',
                    'e2e/terminal.e2e.ts',
                    'e2e/renderer.performance.e2e.ts',
                ]),
                related: ['e2e/files.e2e.ts', 'e2e/renderer.performance.e2e.ts'],
            }),
        ).toEqual(['e2e/files.e2e.ts', 'e2e/settings.e2e.ts', 'e2e/terminal.e2e.ts']);
    });
});
