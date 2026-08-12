import { describe, expect, it } from 'vitest';

import { e2eWorkerTemporaryDirectory, resolveE2EWorkerIsolation } from '../e2e/worker-isolation';

describe('E2E worker isolation', () => {
    it('derives a stable lease namespace from Playwright parallel index', () => {
        expect(
            resolveE2EWorkerIsolation({
                CAXRI_E2E_POOL: 'parallel-safe',
                CAXRI_E2E_COORDINATOR_TOKEN: '01234567-89ab-cdef-0123-456789abcdef',
                TEST_PARALLEL_INDEX: '1',
            }),
        ).toEqual({
            coordinatorToken: '01234567-89ab-cdef-0123-456789abcdef',
            leaseNamespace: 'e2e-worker-1',
            workerNamespace: 'parallel-safe-1',
        });
    });

    it('uses the repository-wide lease outside the parallel-safe pool', () => {
        expect(resolveE2EWorkerIsolation({})).toEqual({});
        expect(resolveE2EWorkerIsolation({ CAXRI_E2E_POOL: 'desktop-exclusive' })).toEqual({});
    });

    it('places profiles, roots, logs, and PTYs below the Playwright worker directory', () => {
        expect(
            e2eWorkerTemporaryDirectory('/tmp', {
                workerNamespace: 'parallel-safe-1',
            }),
        ).toBe('/tmp/caxri-e2e-parallel-safe-1');
        expect(e2eWorkerTemporaryDirectory('/tmp', {})).toBeUndefined();
    });

    it('fails closed when Playwright does not provide a valid parallel index', () => {
        expect(() => resolveE2EWorkerIsolation({ CAXRI_E2E_POOL: 'parallel-safe' })).toThrow(
            'TEST_PARALLEL_INDEX',
        );
        expect(() =>
            resolveE2EWorkerIsolation({
                CAXRI_E2E_POOL: 'parallel-safe',
                CAXRI_E2E_COORDINATOR_TOKEN: '01234567-89ab-cdef-0123-456789abcdef',
                TEST_PARALLEL_INDEX: '../shared',
            }),
        ).toThrow('TEST_PARALLEL_INDEX');
        expect(() =>
            resolveE2EWorkerIsolation({
                CAXRI_E2E_POOL: 'parallel-safe',
                TEST_PARALLEL_INDEX: '0',
            }),
        ).toThrow('coordinator token');
    });
});
