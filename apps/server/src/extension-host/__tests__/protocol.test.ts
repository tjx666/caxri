import { describe, expect, it } from 'vitest';

import { extensionHostParentMessageSchema } from '../protocol';

describe('Extension Host parent protocol', () => {
    it('accepts bounded requests and API replies', () => {
        expect(
            extensionHostParentMessageSchema.parse({
                id: 'shutdown-1',
                method: 'shutdown',
                params: {},
                observation: { requestId: 'control-request', traceId: 'control-trace' },
            }),
        ).toEqual({
            id: 'shutdown-1',
            method: 'shutdown',
            params: {},
            observation: { requestId: 'control-request', traceId: 'control-trace' },
        });
        expect(
            extensionHostParentMessageSchema.safeParse({
                type: 'api-reply',
                id: 'api-1',
                ok: true,
                result: { repositories: [] },
            }).success,
        ).toBe(true);
    });

    it.each([
        { id: 'request-1', method: 'unknown', params: {} },
        { id: 'shutdown-1', method: 'shutdown', params: { unexpected: true } },
        {
            id: 'shutdown-1',
            method: 'shutdown',
            params: {},
            observation: { traceId: '/private/project' },
        },
        {
            id: 'command-1',
            method: 'executeCommand',
            params: {
                extensionId: 'publisher.fixture',
                generation: 1,
                commandId: 'publisher.fixture.command',
                arguments: Array.from({ length: 33 }),
                context: { kind: 'no-session' },
            },
        },
        {
            type: 'api-reply',
            id: 'api-1',
            ok: false,
            error: { code: 'x', message: 'x'.repeat(2_049) },
        },
    ])('rejects malformed, content-bearing, or oversized parent messages', (message) => {
        expect(extensionHostParentMessageSchema.safeParse(message).success).toBe(false);
    });
});
