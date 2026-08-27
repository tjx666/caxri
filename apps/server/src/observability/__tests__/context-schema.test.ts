import { describe, expect, it } from 'vitest';

import { observationContextSchema } from '../context-schema';

describe('observationContextSchema', () => {
    it('accepts bounded opaque identities', () => {
        expect(
            observationContextSchema.parse({
                operationId: 'operation-1',
                processId: 42,
                requestId: 'request-1',
                traceId: 'trace-1',
            }),
        ).toEqual({
            operationId: 'operation-1',
            processId: 42,
            requestId: 'request-1',
            traceId: 'trace-1',
        });
    });

    it.each([
        { requestId: '/private/project/source.ts' },
        { requestId: 'contains source text' },
        { credential: 'secret-token', requestId: 'request-1' },
        { traceId: 'x'.repeat(201) },
    ])('rejects content-bearing or unknown correlation fields', (value) => {
        expect(observationContextSchema.safeParse(value).success).toBe(false);
    });
});
