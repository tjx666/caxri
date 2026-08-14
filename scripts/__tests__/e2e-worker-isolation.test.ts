import { describe, expect, it } from 'vitest';

import { desktopCommandEnvironment } from '../../.agents/skills/switch-worktree/scripts/switch-worktree';
import {
    e2eWorkerTemporaryDirectory,
    resolveE2EWorkerIsolation,
} from '../../e2e/support/worker-isolation';

describe('E2E worker isolation', () => {
    it('passes the desktop coordinator token only to the wrapped command environment', () => {
        const source = { PATH: '/bin' };
        const environment = desktopCommandEnvironment(
            source,
            '01234567-89ab-cdef-0123-456789abcdef',
        );

        expect(environment).toEqual({
            CAXRI_DESKTOP_COORDINATOR_TOKEN: '01234567-89ab-cdef-0123-456789abcdef',
            PATH: '/bin',
        });
        expect(source).toEqual({ PATH: '/bin' });
    });

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

    it('nests a focused E2E launch beneath the switch-worktree desktop coordinator', () => {
        expect(
            resolveE2EWorkerIsolation({
                CAXRI_DESKTOP_COORDINATOR_TOKEN: '01234567-89ab-cdef-0123-456789abcdef',
            }),
        ).toEqual({
            coordinatorToken: '01234567-89ab-cdef-0123-456789abcdef',
            leaseNamespace: 'e2e-desktop-command',
        });
        expect(() =>
            resolveE2EWorkerIsolation({ CAXRI_DESKTOP_COORDINATOR_TOKEN: 'invalid' }),
        ).toThrow('valid coordinator token');
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
