import { describe, expect, it } from 'vitest';

import { platformChecksEnvironment, sanitizedChildEnvironment } from '../ci-child-environment';

/**
 * Mirrors the `e2e` job environment that `scripts/ci-concurrent-validation.ts` inherits.
 */
const e2eJobEnvironment = {
    CAXRI_E2E_AGENT_MODE: 'blocked',
    CAXRI_E2E_FAKE_CODEX_EXECUTABLE: '/fixtures/codex',
    CAXRI_E2E_PROFILE: 'optimized',
    CAXRI_GITHUB_TOKEN: 'job-token',
    SAFE_VALUE: 'kept',
};

describe('CI child environments', () => {
    it('removes only the checkout token from a validation child', () => {
        expect(sanitizedChildEnvironment(e2eJobEnvironment)).toEqual({
            CAXRI_E2E_AGENT_MODE: 'blocked',
            CAXRI_E2E_FAKE_CODEX_EXECUTABLE: '/fixtures/codex',
            CAXRI_E2E_PROFILE: 'optimized',
            SAFE_VALUE: 'kept',
        });
    });

    it('gives platform checks the standalone checks-job environment without E2E variables', () => {
        expect(platformChecksEnvironment(e2eJobEnvironment, 'base-sha')).toEqual({
            CAXRI_REACT_DOCTOR_BASE: 'base-sha',
            SAFE_VALUE: 'kept',
        });
    });
});
