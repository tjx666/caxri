import { describe, expect, it } from 'vitest';

import { checksWorktreePath } from '../ci-checks-worktree';
import { isVerificationPassed } from '../ci-concurrent-validation';
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
    });
});
