import { describe, expect, it } from 'vitest';

import {
    evaluateRetryPolicy,
    extractBaseRunIdentity,
    isProtectedRetryPath,
    parseRetryHint,
    type RetryPolicyInput,
} from './ci-retry-policy';

const tree = 'a'.repeat(40);
const eligible: RetryPolicyInput = {
    baseRun: {
        baseSha: 'base',
        checksConclusion: 'success',
        e2eConclusion: 'failure',
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
            { ...eligible, changedFiles: ['package-lock.json'] },
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
            'package.json',
            'package-lock.json',
            'vitest.config.ts',
            'playwright.config.ts',
            'electron.vite.config.ts',
            'tsconfig.node.json',
            '.agents/skills/release/SKILL.md',
            '.agents/skills/e2e-testing/SKILL.md',
            'scripts/ci-retry-policy.ts',
            'RELEASING.md',
        ]) {
            expect(isProtectedRetryPath(path), path).toBe(true);
        }
        expect(isProtectedRetryPath('src/runtime/index.ts')).toBe(false);
    });
});
