import { describe, expect, it } from 'vitest';

import { requestEnvelopeSchema } from '../contracts';

describe('requestEnvelopeSchema', () => {
    it.each(['constructor', 'toString', '__proto__'])('rejects inherited method %s', (method) => {
        expect(
            requestEnvelopeSchema.safeParse({ id: 'request-1', method, params: {} }).success,
        ).toBe(false);
    });
});
