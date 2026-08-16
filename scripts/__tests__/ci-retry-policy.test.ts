import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { RetryPolicyInput } from '../ci-retry-policy';
import {
    evaluateRetryPolicy,
    extractBaseRunIdentity,
    extractGreenRunEvidence,
    greenReuseDiffArguments,
    isProtectedRetryPath,
    parseRetryHint,
    summarizeE2EJobs,
} from '../ci-retry-policy';

const tree = 'a'.repeat(40);
const eligible: RetryPolicyInput = {
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
    baseRunChangedFiles: ['src/runtime/base.ts'],
    changedFiles: ['src/runtime/index.ts'],
    currentTree: tree,
    eventName: 'pull_request',
    hint: { baseRunId: 123, mode: 'e2e-only', validatedTree: tree },
    isAncestor: true,
    pullRequestBaseSha: 'base',
    pullRequestNumber: 17,
    repository: 'tjx666/caxri',
    workflowPath: '.github/workflows/ci.yml',
};

describe('CI retry policy', () => {
    it('parses one complete immutable retry receipt', () => {
        expect(
            parseRetryHint(
                `repair\n\nCI-Mode: e2e-only\nCI-Base-Run: 123\nCI-Validated-Tree: ${tree}`,
            ),
        ).toEqual({ hint: eligible.hint });
        expect(parseRetryHint('ordinary commit')).toEqual({});
        expect(parseRetryHint('CI-Mode: e2e-only')).toEqual({
            error: 'CI-Base-Run must be numeric',
        });
        expect(
            parseRetryHint(
                `repair\n\nCI-Mode: e2e-repair\nCI-Base-Run: 123\nCI-E2E-Tests: ["e2e/files.e2e.ts"]\nCI-Validated-Tree: ${tree}`,
            ),
        ).toEqual({
            hint: {
                ...eligible.hint,
                e2eTests: ['e2e/files.e2e.ts'],
                mode: 'e2e-repair',
            },
        });
    });

    it('admits only the exact PR tree with successful checks and failed e2e', () => {
        expect(evaluateRetryPolicy(eligible)).toMatchObject({ mode: 'e2e-only' });
        for (const input of [
            { ...eligible, eventName: 'push' },
            { ...eligible, currentTree: 'b'.repeat(40) },
            { ...eligible, isAncestor: false },
            { ...eligible, pullRequestBaseSha: 'changed' },
            { ...eligible, workflowPath: '.github/workflows/other.yml' },
            {
                ...eligible,
                baseRun: { ...eligible.baseRun!, checksConclusion: 'failure' },
            },
            { ...eligible, changedFiles: ['pnpm-lock.yaml'] },
            { ...eligible, baseRunChangedFiles: ['.github/workflows/ci.yml'] },
        ]) {
            expect(evaluateRetryPolicy(input).mode).toBe('full');
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
            e2eFailurePool: 'control',
        });
        expect(
            summarizeE2EJobs([
                { name: 'e2e / parallel-safe', conclusion: 'failure' },
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
                        steps: [{ conclusion: 'success', name: 'Run ESLint' }],
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

    it('disables rename detection so moving product code into an allowed path cannot hide it', () => {
        expect(greenReuseDiffArguments('ancestor', 'current')).toEqual([
            'diff',
            '--no-renames',
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
            'scripts/ci-execution-plan.ts',
            'scripts/ci-green-reuse.ts',
            'scripts/ci-metrics.ts',
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
            'e2e/failure-isolation.e2e.ts',
            'RELEASING.md',
        ]) {
            expect(isProtectedRetryPath(path), path).toBe(true);
        }
        expect(isProtectedRetryPath('src/runtime/index.ts')).toBe(false);
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
});
