import { describe, expect, it } from 'vitest';

import { resolveTestRootPath } from '../test-root';

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
});
