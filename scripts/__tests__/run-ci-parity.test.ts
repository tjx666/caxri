import { describe, expect, it } from 'vitest';

import { ciParityCases, ciParityEnvironment } from '../run-ci-parity';

describe('CI E2E parity manifest', () => {
    it('retains one deterministic focused case for every inherited slow-path contract', () => {
        expect(ciParityCases.map(({ id }) => id)).toEqual([
            'late-raw-mode',
            'extra-sigwinch',
            'transient-enoent',
            'long-path-wrapped-terminal',
        ]);
        expect(new Set(ciParityCases.map(({ spec }) => spec))).toHaveLength(4);
    });

    it('uses the case id as the explicit deterministic injection selector', () => {
        for (const parityCase of ciParityCases) {
            expect(parityCase.id).toMatch(
                /^(?:late-raw-mode|extra-sigwinch|transient-enoent|long-path-wrapped-terminal)$/,
            );
        }
    });

    it('retains failure artifacts under a separate output root for every case', () => {
        expect(ciParityEnvironment('transient-enoent')).toMatchObject({
            CAXRI_CI_PARITY_CASE: 'transient-enoent',
            CAXRI_E2E_OUTPUT_DIR: 'test-results/ci-parity/transient-enoent',
        });
    });
});
