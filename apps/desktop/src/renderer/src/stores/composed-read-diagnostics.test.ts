import { describe, expect, it } from 'vitest';

import type { ComposedReadSample } from './composed-read-diagnostics';
import {
    COMPOSED_READ_SAMPLE_EVERY,
    COMPOSED_READ_SLOW_BUDGET_MS,
    ComposedReadMeter,
} from './composed-read-diagnostics';

function sample(overrides: Partial<ComposedReadSample> = {}): ComposedReadSample {
    return {
        connectedHostCount: 1,
        dirtyHostCount: 1,
        localBootstrapMs: 4,
        remoteReadCount: 1,
        remoteReadMs: 6,
        totalMs: 10,
        ...overrides,
    };
}

function meter() {
    const reported: unknown[] = [];
    const instance = new ComposedReadMeter({
        createDiagnosticId: () => 'id',
        reportDiagnostic: (diagnostic) => reported.push(diagnostic),
    });
    return { instance, reported };
}

describe('ComposedReadMeter', () => {
    it('stays silent for fast reads', () => {
        const { instance, reported } = meter();
        instance.record(sample());
        instance.record(sample({ dirtyHostCount: 0, remoteReadCount: 0, remoteReadMs: 0 }));
        expect(reported).toEqual([]);
    });

    it('reports a slow read with the aggregates so far', () => {
        const { instance, reported } = meter();
        instance.record(sample());
        instance.record(sample({ totalMs: COMPOSED_READ_SLOW_BUDGET_MS + 0.4, remoteReadMs: 300 }));
        expect(reported).toEqual([
            {
                kind: 'workbench-composed-read',
                diagnosticId: 'id',
                trigger: 'host-change',
                slow: true,
                totalMs: 250,
                localBootstrapMs: 4,
                remoteReadMs: 300,
                connectedHostCount: 1,
                remoteReadCount: 1,
                composedReadCount: 2,
                hostChangeReadCount: 2,
                slowReadCount: 1,
            },
        ]);
    });

    it('reports a slow local-only read even with no connected Host', () => {
        const { instance, reported } = meter();
        instance.record(
            sample({
                connectedHostCount: 0,
                dirtyHostCount: 0,
                remoteReadCount: 0,
                remoteReadMs: 0,
                totalMs: 900,
            }),
        );
        expect(reported).toMatchObject([{ trigger: 'local', slow: true, slowReadCount: 1 }]);
    });

    it('samples every Nth Host-triggered read, counting local reads separately', () => {
        const { instance, reported } = meter();
        for (let index = 0; index < COMPOSED_READ_SAMPLE_EVERY - 1; index += 1) {
            instance.record(sample());
            instance.record(sample({ dirtyHostCount: 0 }));
        }
        expect(reported).toEqual([]);
        instance.record(sample());
        expect(reported).toMatchObject([
            {
                trigger: 'host-change',
                slow: false,
                hostChangeReadCount: COMPOSED_READ_SAMPLE_EVERY,
                composedReadCount: COMPOSED_READ_SAMPLE_EVERY * 2 - 1,
                slowReadCount: 0,
            },
        ]);
    });
});
