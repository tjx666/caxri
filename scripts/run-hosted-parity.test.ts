import { describe, expect, it } from 'vitest';

import { hostedParityCases, hostedParityEnvironment } from './run-hosted-parity';

describe('hosted E2E parity manifest', () => {
    it('retains one deterministic focused case for every inherited slow-path contract', () => {
        expect(hostedParityCases.map(({ id }) => id)).toEqual([
            'late-raw-mode',
            'extra-sigwinch',
            'transient-enoent',
            'long-path-wrapped-terminal',
        ]);
        expect(new Set(hostedParityCases.map(({ spec }) => spec))).toHaveLength(4);
    });

    it('uses the case id as the explicit deterministic injection selector', () => {
        for (const parityCase of hostedParityCases) {
            expect(parityCase.id).toMatch(
                /^(?:late-raw-mode|extra-sigwinch|transient-enoent|long-path-wrapped-terminal)$/,
            );
        }
    });

    it('retains failure artifacts under a separate output root for every case', () => {
        expect(hostedParityEnvironment('transient-enoent')).toMatchObject({
            CAXRI_E2E_OUTPUT_DIR: 'test-results/hosted-parity/transient-enoent',
            CAXRI_HOSTED_PARITY_CASE: 'transient-enoent',
        });
    });
});
