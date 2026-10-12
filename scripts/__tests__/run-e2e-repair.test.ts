import { describe, expect, it } from 'vitest';

import { resolveE2ELaunchPolicy } from '../../e2e/support/worker-isolation';
import {
    createParallelSafeRepairEnvironment,
    parseE2EPool,
    parseE2ERepeat,
    parseSpecPaths,
    resolveOwnedRunnerTemporaryDirectory,
} from '../run-e2e-repair';

describe('focused E2E repair argv', () => {
    it('accepts only unique repository E2E spec paths', () => {
        expect(
            parseSpecPaths('["e2e/files.e2e.ts","e2e/terminal-links.e2e.ts","e2e/files.e2e.ts"]'),
        ).toEqual(['e2e/files.e2e.ts', 'e2e/terminal-links.e2e.ts']);
    });

    it.each([
        'null',
        '[]',
        '["--grep","secret"]',
        '["../outside.e2e.ts"]',
        '["/tmp/outside.e2e.ts"]',
        '["e2e/not-a-spec.ts"]',
    ])('rejects non-spec argv %s', (value) => {
        expect(() => parseSpecPaths(value)).toThrow('validated E2E spec paths');
    });

    it('keeps focused retries aligned with the failed hosted pool', () => {
        expect(parseE2EPool(undefined)).toBe('control');
        expect(parseE2EPool('parallel-safe')).toBe('parallel-safe');
        expect(parseE2EPool('desktop-exclusive')).toBe('desktop-exclusive');
        expect(() => parseE2EPool('unknown')).toThrow('CI_E2E_POOL');
    });

    it('keeps serial repetitions inside the parallel-safe pool policy', () => {
        const environment = createParallelSafeRepairEnvironment(
            {
                CAXRI_DESKTOP_COORDINATOR_TOKEN: 'stale-desktop-token',
                CAXRI_E2E_COORDINATOR_TOKEN: 'stale-e2e-token',
            },
            'current-e2e-token',
            'test-results/e2e-repair-serial',
            '/private/tmp/cxr-abcd12',
        );

        expect(environment).toMatchObject({
            CAXRI_E2E_COORDINATOR_TOKEN: 'current-e2e-token',
            CAXRI_E2E_OUTPUT_DIR: 'test-results/e2e-repair-serial',
            CAXRI_E2E_POOL: 'parallel-safe',
            TEMP: '/private/tmp/cxr-abcd12',
            TMP: '/private/tmp/cxr-abcd12',
            TMPDIR: '/private/tmp/cxr-abcd12',
        });
        expect(environment.CAXRI_DESKTOP_COORDINATOR_TOKEN).toBeUndefined();
        expect(
            resolveE2ELaunchPolicy(environment, {
                clipboard: false,
                gpuMode: 'disabled',
                windowMode: 'hidden',
            }),
        ).toEqual({
            protectClipboard: false,
        });
    });

    it('keeps hosted repair data inside the runner-owned temporary root', () => {
        const owner = 'caxri-33324692364-1-e2e';
        expect(
            resolveOwnedRunnerTemporaryDirectory({
                CAXRI_RUNNER_OWNER: owner,
                TMPDIR: `/private/tmp/${owner}`,
            }),
        ).toBe(`/private/tmp/${owner}`);
        expect(
            resolveOwnedRunnerTemporaryDirectory({ TMPDIR: '/private/tmp/local' }),
        ).toBeUndefined();
    });

    it('rejects a hosted temporary root outside its declared owner', () => {
        expect(() =>
            resolveOwnedRunnerTemporaryDirectory({
                CAXRI_RUNNER_OWNER: 'caxri-33324692364-1-e2e',
                TMPDIR: '/private/tmp/foreign',
            }),
        ).toThrow('runner-owned TMPDIR');
    });

    it('repeats repair specs three times and affected specs once', () => {
        expect(parseE2ERepeat(undefined)).toBe(3);
        expect(parseE2ERepeat('')).toBe(3);
        expect(parseE2ERepeat('1')).toBe(1);
        expect(() => parseE2ERepeat('2')).toThrow('CI_E2E_REPEAT');
    });
});
