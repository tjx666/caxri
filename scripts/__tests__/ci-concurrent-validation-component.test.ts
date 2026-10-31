import { describe, expect, it } from 'vitest';

import {
    isVerificationPassed,
    parseConcurrentValidationReceipt,
    resolveE2EComponent,
} from '../ci-concurrent-validation';

const greenReceipt = {
    checks: 0,
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

/**
 * The hosted-full route runs the exclusive pool and each parallel-safe shard on separate runners (#1869), so each
 * runner's receipt leaves the other component's entries `null`.
 */
describe('concurrent CI validation components', () => {
    it('verifies a parallel-safe shard receipt that never ran the checks or the exclusive pool', () => {
        const shardReceipt = {
            ...greenReceipt,
            checks: null,
            desktopExclusive: null,
            failureCensus: null,
            failureIsolation: null,
        };
        expect(parseConcurrentValidationReceipt(shardReceipt)).toMatchObject({ checks: null });
        expect(isVerificationPassed(shardReceipt, 'parallel-safe', greenReceipt.provenance)).toBe(
            true,
        );
        // A null entry means "did not run here" and never satisfies a verification of that component.
        for (const component of ['checks', 'desktop-exclusive', 'e2e-auxiliary'] as const) {
            expect(isVerificationPassed(shardReceipt, component, greenReceipt.provenance)).toBe(
                false,
            );
        }
        for (const broken of [{ manifest: 1 }, { manifest: null }, { e2eSetup: 1 }]) {
            expect(
                isVerificationPassed(
                    { ...shardReceipt, ...broken },
                    'parallel-safe',
                    greenReceipt.provenance,
                ),
            ).toBe(false);
        }
    });

    it('requires an explicit E2E component selector', () => {
        expect(resolveE2EComponent({ CAXRI_E2E_COMPONENT: 'exclusive' })).toBe('exclusive');
        expect(resolveE2EComponent({ CAXRI_E2E_COMPONENT: 'parallel-safe' })).toBe('parallel-safe');
        expect(() => resolveE2EComponent({})).toThrow('CAXRI_E2E_COMPONENT');
        expect(() => resolveE2EComponent({ CAXRI_E2E_COMPONENT: 'all' })).toThrow(
            'CAXRI_E2E_COMPONENT',
        );
    });
});
