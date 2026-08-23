import { describe, expect, it } from 'vitest';

import {
    authenticatedGitEnvironment,
    checksWorktreePath,
    sanitizedChildEnvironment,
} from '../ci-checks-worktree';
import {
    concurrentValidationProvenance,
    isVerificationPassed,
    parseConcurrentValidationReceipt,
} from '../ci-concurrent-validation';
import { platformCheckCommands } from '../ci-platform-checks';

const greenReceipt = {
    checks: 0,
    ciParity: 0,
    desktopExclusive: 0,
    e2eSetup: 0,
    failureCensus: 0,
    failureIsolation: 0,
    manifest: 0,
    parallelSafe: 0,
    provenance: {
        checksRevision: 'b'.repeat(40),
        exactHead: 'a'.repeat(40),
        parallelWorkers: 3,
        profile: 'optimized' as const,
        runAttempt: '1',
        runId: '123',
    },
    version: 1 as const,
};

describe('concurrent CI validation', () => {
    it('retains every full platform gate in its original fail-fast order', () => {
        const checks = platformCheckCommands({
            CAXRI_VITEST_MAX_WORKERS: '2',
            CAXRI_VITEST_PARTITION: 'optimized',
            ESLINT_CONCURRENCY: 'off',
        });

        expect(checks.map(({ label }) => label)).toEqual([
            'ESLint',
            'oxlint type-aware',
            'markdownlint',
            'knip',
            'React Doctor',
            'TypeScript',
            'format',
            'unit and integration tests',
            'bundle budget',
        ]);
        expect(checks.at(-1)?.arguments).toContain('scripts/ci-bundle-budget.ts');
    });

    it('fails each independently receipted validation surface closed', () => {
        expect(isVerificationPassed(greenReceipt, 'checks')).toBe(true);
        expect(isVerificationPassed(greenReceipt, 'parallel-safe')).toBe(true);
        expect(isVerificationPassed(greenReceipt, 'desktop-exclusive')).toBe(true);
        expect(isVerificationPassed(greenReceipt, 'e2e-auxiliary')).toBe(true);
        expect(isVerificationPassed({ ...greenReceipt, checks: 1 }, 'checks')).toBe(false);
        expect(isVerificationPassed({ ...greenReceipt, parallelSafe: null }, 'parallel-safe')).toBe(
            false,
        );
        expect(isVerificationPassed({ ...greenReceipt, failureCensus: 1 }, 'e2e-auxiliary')).toBe(
            false,
        );
        expect(
            isVerificationPassed(greenReceipt, 'checks', {
                ...greenReceipt.provenance,
                runAttempt: '2',
            }),
        ).toBe(false);
        expect(() => parseConcurrentValidationReceipt({ checks: 0 })).toThrow(
            'Invalid concurrent validation receipt',
        );
    });

    it('derives immutable receipt provenance from the current Actions attempt', () => {
        expect(
            concurrentValidationProvenance({
                CAXRI_CHECKS_REVISION: 'b'.repeat(40),
                CAXRI_E2E_PARALLEL_WORKERS: '3',
                CAXRI_E2E_PROFILE: 'optimized',
                CAXRI_EXPECTED_HEAD: 'a'.repeat(40),
                GITHUB_RUN_ATTEMPT: '2',
                GITHUB_RUN_ID: '456',
            }),
        ).toEqual({
            checksRevision: 'b'.repeat(40),
            exactHead: 'a'.repeat(40),
            parallelWorkers: 3,
            profile: 'optimized',
            runAttempt: '2',
            runId: '456',
        });
    });

    it('derives the disposable checks checkout only from the owned E2E temp root', () => {
        expect(
            checksWorktreePath({
                CAXRI_RUNNER_OWNER: 'caxri-123-1-e2e',
                TMPDIR: '/private/tmp/caxri-123-1-e2e',
            }),
        ).toBe('/private/tmp/caxri-123-1-e2e/synthetic-merge-checks');
        expect(() =>
            checksWorktreePath({
                CAXRI_RUNNER_OWNER: 'unowned',
                TMPDIR: '/private/tmp/unowned',
            }),
        ).toThrow('Invalid E2E runner owner');
        expect(() =>
            checksWorktreePath({
                CAXRI_RUNNER_OWNER: 'caxri-123-1-e2e',
                TMPDIR: '/tmp/foreign-root',
            }),
        ).toThrow('does not match the owned short temporary path');
    });

    it('authenticates a missing synthetic merge fetch without persisting the job token', () => {
        const environment = authenticatedGitEnvironment({
            CAXRI_GITHUB_TOKEN: 'job-token',
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'existing.key',
            GIT_CONFIG_VALUE_0: 'existing-value',
        });

        expect(environment).toMatchObject({
            GIT_CONFIG_COUNT: '2',
            GIT_CONFIG_KEY_0: 'existing.key',
            GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
            GIT_CONFIG_VALUE_0: 'existing-value',
        });
        expect(environment.GIT_CONFIG_VALUE_1).toMatch(/^AUTHORIZATION: basic /u);
        expect(environment.GIT_CONFIG_VALUE_1).not.toContain('job-token');
        expect(
            sanitizedChildEnvironment({ CAXRI_GITHUB_TOKEN: 'job-token', SAFE_VALUE: 'kept' }),
        ).toEqual({ SAFE_VALUE: 'kept' });
    });
});
