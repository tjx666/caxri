import { describe, expect, it } from 'vitest';

import { resolveE2ETerminalOutputFlushDelay } from '../e2e-options';

describe('resolveE2ETerminalOutputFlushDelay', () => {
    it('ignores the test seam outside an explicit E2E launch', () => {
        expect(
            resolveE2ETerminalOutputFlushDelay({
                CAXRI_E2E_TERMINAL_OUTPUT_FLUSH_DELAY_MS: '1000',
            }),
        ).toBeUndefined();
    });

    it('accepts one bounded delay only for an explicit E2E launch', () => {
        expect(resolveE2ETerminalOutputFlushDelay({ CAXRI_E2E: '1' })).toBeUndefined();
        expect(
            resolveE2ETerminalOutputFlushDelay({
                CAXRI_E2E: '1',
                CAXRI_E2E_TERMINAL_OUTPUT_FLUSH_DELAY_MS: '1000',
            }),
        ).toBe(1000);
    });

    it.each(['0', '-1', '1.5', '5001', 'invalid'])(
        'fails closed for an invalid E2E delay: %s',
        (delay) => {
            expect(() =>
                resolveE2ETerminalOutputFlushDelay({
                    CAXRI_E2E: '1',
                    CAXRI_E2E_TERMINAL_OUTPUT_FLUSH_DELAY_MS: delay,
                }),
            ).toThrow('must be an integer from 1 to 5000');
        },
    );
});
