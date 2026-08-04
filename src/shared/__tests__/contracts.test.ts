import { describe, expect, it } from 'vitest';

import { requestEnvelopeSchema, requestSchemas } from '../contracts';

describe('requestEnvelopeSchema', () => {
    it.each(['constructor', 'toString', '__proto__'])('rejects inherited method %s', (method) => {
        expect(
            requestEnvelopeSchema.safeParse({ id: 'request-1', method, params: {} }).success,
        ).toBe(false);
    });
});

describe('files.write contract', () => {
    it('supports the largest configurable text file without exceeding the IPC boundary', () => {
        const maximum = 16 * 1024 * 1024;
        const base = { sessionId: 'session-1', path: '/project/note.txt' };

        expect(
            requestSchemas['files.write'].safeParse({ ...base, content: 'x'.repeat(maximum) })
                .success,
        ).toBe(true);
        expect(
            requestSchemas['files.write'].safeParse({ ...base, content: 'x'.repeat(maximum + 1) })
                .success,
        ).toBe(false);
    });
});
