import { describe, expect, it } from 'vitest';

import { resolveE2EMaxFailures } from '../reporters/e2e-max-failures-policy';

describe('E2E max failures policy', () => {
    it('keeps the CI cap of three and the unlimited local default', () => {
        expect(resolveE2EMaxFailures({ CI: 'true' })).toBe(3);
        expect(resolveE2EMaxFailures({})).toBe(0);
    });

    it('lets a hosted-full leg lift the cap so one invocation records every failure', () => {
        expect(resolveE2EMaxFailures({ CAXRI_E2E_MAX_FAILURES: '0', CI: 'true' })).toBe(0);
        expect(resolveE2EMaxFailures({ CAXRI_E2E_MAX_FAILURES: '5', CI: 'true' })).toBe(5);
        expect(resolveE2EMaxFailures({ CAXRI_E2E_MAX_FAILURES: '', CI: 'true' })).toBe(3);
    });

    it('rejects a malformed override instead of silently capping', () => {
        expect(() => resolveE2EMaxFailures({ CAXRI_E2E_MAX_FAILURES: '-1' })).toThrow(
            'CAXRI_E2E_MAX_FAILURES',
        );
        expect(() => resolveE2EMaxFailures({ CAXRI_E2E_MAX_FAILURES: 'off' })).toThrow(
            'CAXRI_E2E_MAX_FAILURES',
        );
    });
});
