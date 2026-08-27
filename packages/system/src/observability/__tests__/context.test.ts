import { describe, expect, it } from 'vitest';

import {
    currentObservationContext,
    mergeObservationContext,
    normalizeObservationContext,
    runWithObservationContext,
} from '../context';

describe('observation context', () => {
    it('propagates and narrows correlation across asynchronous work', async () => {
        await runWithObservationContext(
            { buildId: 'build-1', serverId: 'server-1', traceId: 'trace-1' },
            async () => {
                await Promise.resolve();
                expect(currentObservationContext()).toEqual({
                    buildId: 'build-1',
                    serverId: 'server-1',
                    traceId: 'trace-1',
                });
                expect(
                    mergeObservationContext(currentObservationContext(), {
                        requestId: 'request-1',
                    }),
                ).toEqual({
                    buildId: 'build-1',
                    requestId: 'request-1',
                    serverId: 'server-1',
                    traceId: 'trace-1',
                });
            },
        );
        expect(currentObservationContext()).toEqual({});
    });

    it('omits paths, prose, credentials, invalid pids, and oversized identities', () => {
        expect(
            normalizeObservationContext({
                processId: -1,
                requestId: '/private/project/source.ts',
                sessionId: 'contains spaces and prose',
                terminalId: 'x'.repeat(201),
                traceId: 'trace-safe',
            }),
        ).toEqual({ traceId: 'trace-safe' });
    });
});
