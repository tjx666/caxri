import { describe, expect, it } from 'vitest';

import { createTestRootPathResolver, resolveTestRootPath } from '../test-root';

describe('resolveTestRootPath', () => {
    it('requires an explicit development E2E launch', () => {
        const environment = { CAXRI_E2E: '1', CAXRI_TEST_ROOT_PATH: '/project' };

        expect(resolveTestRootPath({ environment, isPackaged: false })).toBe('/project');
        expect(resolveTestRootPath({ environment, isPackaged: true })).toBeUndefined();
        expect(
            resolveTestRootPath({
                environment: { CAXRI_TEST_ROOT_PATH: '/project' },
                isPackaged: false,
            }),
        ).toBeUndefined();
    });

    it('queues multiple deterministic roots and keeps the final root after exhaustion', () => {
        const environment = {
            CAXRI_E2E: '1',
            CAXRI_TEST_ROOT_PATH: '/fallback',
            CAXRI_TEST_ROOT_PATHS: JSON.stringify(['/alpha', '/beta', '/gamma']),
        };
        const nextRoot = createTestRootPathResolver({ environment, isPackaged: false });

        expect(nextRoot()).toBe('/alpha');
        expect(nextRoot()).toBe('/beta');
        expect(nextRoot()).toBe('/gamma');
        expect(nextRoot()).toBe('/gamma');
    });
});
