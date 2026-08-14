import { describe, expect, it } from 'vitest';

import { formatMetricReceipt, processTreeRSSKiB } from '../ci-metrics';

describe('CI command metrics', () => {
    it('adds the root process and recursive descendants without unrelated RSS', () => {
        const snapshot = `
          10 1 100
          11 10 200
          12 11 300
          99 1 900
        `;

        expect(processTreeRSSKiB(snapshot, 10)).toBe(600);
        expect(processTreeRSSKiB(snapshot, 99)).toBe(900);
        expect(processTreeRSSKiB(snapshot, 404)).toBeUndefined();
    });

    it('emits a machine-readable receipt without allowing labels to forge log lines', () => {
        expect(
            JSON.parse(
                formatMetricReceipt({
                    elapsedSeconds: 1.25,
                    exitCode: 0,
                    label: 'Vitest\nforged',
                    peakRSSKiB: 2_048,
                }).replace(/^CAXRI_CI_METRIC /u, ''),
            ),
        ).toEqual({
            elapsedSeconds: 1.25,
            exitCode: 0,
            label: 'Vitest forged',
            peakRSSMiB: 2,
        });
    });
});
