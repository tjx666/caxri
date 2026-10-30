import { describe, expect, it } from 'vitest';

import { shouldEnableAcceptanceAccessibility } from '../accessibility';

describe('shouldEnableAcceptanceAccessibility', () => {
    it('enables the native tree only for the explicit macOS Acceptance launch', () => {
        expect(
            shouldEnableAcceptanceAccessibility({
                environment: { CAXRI_ACCEPTANCE: '1' },
                platform: 'darwin',
            }),
        ).toBe(true);
        expect(
            shouldEnableAcceptanceAccessibility({
                environment: { CAXRI_E2E: '1' },
                platform: 'darwin',
            }),
        ).toBe(false);
        expect(
            shouldEnableAcceptanceAccessibility({
                environment: { CAXRI_ACCEPTANCE: '1' },
                platform: 'linux',
            }),
        ).toBe(false);
    });
});
