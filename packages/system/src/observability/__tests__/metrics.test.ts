import { describe, expect, it } from 'vitest';

import { BoundedMetricRegistry, MAX_OBSERVATION_METRIC_SERIES } from '../metrics';

describe('BoundedMetricRegistry', () => {
    it('aggregates values without retaining per-request samples', () => {
        const metrics = new BoundedMetricRegistry();
        const labels = { owner: 'control', phase: 'admission', outcome: 'success' } as const;
        metrics.record('queue.wait', 2, labels);
        metrics.record('queue.wait', 4, labels);

        expect(metrics.snapshot()).toEqual({
            rejectedSeries: 0,
            series: [
                {
                    average: 3,
                    count: 2,
                    labels,
                    last: 4,
                    maximum: 4,
                    minimum: 2,
                    name: 'queue.wait',
                    total: 6,
                },
            ],
        });
    });

    it('stays within the fixed series ceiling', () => {
        const metrics = new BoundedMetricRegistry();
        for (let index = 0; index < MAX_OBSERVATION_METRIC_SERIES + 4; index++) {
            metrics.record('queue.wait', index, {
                owner: 'control',
                phase: index % 2 === 0 ? 'admission' : 'execute',
                outcome: index % 3 === 0 ? 'success' : 'failure',
            });
        }

        expect(metrics.snapshot().series).toHaveLength(4);
        expect(metrics.snapshot().rejectedSeries).toBe(0);
    });
});
