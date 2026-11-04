import { APPROVAL_ESCALATION_GRACE_MS } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { resolveApprovalGraceMs } from '../e2e-grace';

describe('resolveApprovalGraceMs', () => {
    it('keeps the production grace unless the E2E seam is enabled', () => {
        expect(resolveApprovalGraceMs({})).toBe(APPROVAL_ESCALATION_GRACE_MS);
        expect(resolveApprovalGraceMs({ CAXRI_E2E_APPROVAL_GRACE_MS: '2000' })).toBe(
            APPROVAL_ESCALATION_GRACE_MS,
        );
        expect(resolveApprovalGraceMs({ CAXRI_E2E: '1' })).toBe(APPROVAL_ESCALATION_GRACE_MS);
    });

    it('shortens the grace under CAXRI_E2E and rejects out-of-range values', () => {
        const environment = (value: string) => ({
            CAXRI_E2E: '1',
            CAXRI_E2E_APPROVAL_GRACE_MS: value,
        });
        expect(resolveApprovalGraceMs(environment('3000'))).toBe(3000);
        expect(() => resolveApprovalGraceMs(environment('100'))).toThrow(/must be an integer/u);
        expect(() => resolveApprovalGraceMs(environment('90000'))).toThrow(/must be an integer/u);
        expect(() => resolveApprovalGraceMs(environment('abc'))).toThrow(/must be an integer/u);
    });
});
