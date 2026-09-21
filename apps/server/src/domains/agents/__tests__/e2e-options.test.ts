import { describe, expect, it } from 'vitest';

import { resolveE2EAgentUnknownRecoveryMs } from '../e2e-options';

describe('resolveE2EAgentUnknownRecoveryMs', () => {
    it('ignores the test seam outside an explicit E2E launch', () => {
        expect(
            resolveE2EAgentUnknownRecoveryMs({ CAXRI_E2E_AGENT_UNKNOWN_RECOVERY_MS: '4000' }),
        ).toBeUndefined();
    });

    it('accepts one bounded window only for an explicit E2E launch', () => {
        expect(resolveE2EAgentUnknownRecoveryMs({ CAXRI_E2E: '1' })).toBeUndefined();
        expect(
            resolveE2EAgentUnknownRecoveryMs({
                CAXRI_E2E: '1',
                CAXRI_E2E_AGENT_UNKNOWN_RECOVERY_MS: '4000',
            }),
        ).toBe(4000);
    });

    /**
     * `120000` is the production window: accepting it would reintroduce the two-minute wait the seam exists to remove,
     * so the upper bound refuses it rather than treating it as a no-op override.
     */
    it.each(['0', '-1', '999', '1.5', '30001', '120000', 'invalid'])(
        'fails closed for an invalid E2E recovery window: %s',
        (window) => {
            expect(() =>
                resolveE2EAgentUnknownRecoveryMs({
                    CAXRI_E2E: '1',
                    CAXRI_E2E_AGENT_UNKNOWN_RECOVERY_MS: window,
                }),
            ).toThrow('must be an integer from 1000 to 30000');
        },
    );
});
