import { describe, expect, it } from 'vitest';

import { rendererDiagnosticSchema } from '../renderer-diagnostic.js';

describe('workbench-composed-read diagnostic', () => {
    const valid = {
        kind: 'workbench-composed-read',
        diagnosticId: 'b0f1c2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
        trigger: 'host-change',
        slow: true,
        totalMs: 320,
        localBootstrapMs: 40,
        remoteReadMs: 300,
        connectedHostCount: 2,
        remoteReadCount: 1,
        composedReadCount: 10,
        hostChangeReadCount: 6,
        slowReadCount: 2,
    };

    it('accepts a content-free composed read record', () => {
        expect(rendererDiagnosticSchema.parse(valid)).toEqual(valid);
    });

    it('rejects extra identifying fields, unknown triggers, and inconsistent aggregates', () => {
        for (const invalid of [
            { ...valid, hostName: 'build-box' },
            { ...valid, trigger: 'unknown' },
            { ...valid, totalMs: -1 },
            { ...valid, hostChangeReadCount: 11 },
            { ...valid, slowReadCount: 11 },
            { ...valid, remoteReadCount: 3 },
        ])
            expect(rendererDiagnosticSchema.safeParse(invalid).success).toBe(false);
    });
});
