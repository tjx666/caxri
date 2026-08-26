import { describe, expect, it } from 'vitest';

import {
    BoundedMetricRegistry,
    MAX_OBSERVATION_METRIC_SERIES,
    observationMetricNames,
    observationOutcomes,
    observationOwners,
    observationPhases,
} from '../metrics';

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
        let attemptedSeries = 0;
        for (const name of observationMetricNames)
            for (const owner of observationOwners)
                for (const phase of observationPhases)
                    for (const outcome of observationOutcomes) {
                        metrics.record(name, attemptedSeries, { owner, phase, outcome });
                        attemptedSeries += 1;
                    }

        expect(metrics.snapshot().series).toHaveLength(MAX_OBSERVATION_METRIC_SERIES);
        expect(metrics.snapshot().rejectedSeries).toBe(
            attemptedSeries - MAX_OBSERVATION_METRIC_SERIES,
        );
    });
});
