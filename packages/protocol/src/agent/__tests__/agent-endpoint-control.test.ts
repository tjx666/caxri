import { describe, expect, it } from 'vitest';

import {
    runtimeHostControlReplySchema,
    runtimeHostControlRequestSchema,
} from '../agent-endpoint-control.js';

const endpointReference = { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 };

describe('runtimeHostControlRequestSchema', () => {
    it('accepts each known operation with its own matching parameter shape', () => {
        expect(
            runtimeHostControlRequestSchema.safeParse({
                type: 'host-control.request',
                id: 'request-1',
                operation: 'agent-endpoint.activate',
                params: { ref: endpointReference, launchId: 'launch-1' },
            }).success,
        ).toBe(true);
        expect(
            runtimeHostControlRequestSchema.safeParse({
                type: 'host-control.request',
                id: 'request-2',
                operation: 'agent-endpoint.retire',
                params: { ref: endpointReference, launchId: 'launch-1' },
            }).success,
        ).toBe(true);
    });

    it('rejects an operation whose params do not match its own discriminant branch', () => {
        expect(
            runtimeHostControlRequestSchema.safeParse({
                type: 'host-control.request',
                id: 'request-1',
                // "activate" params require launchId, not the begin-only launch fields.
                operation: 'agent-endpoint.activate',
                params: {
                    terminalId: 'terminal-1',
                    sessionId: 'session-1',
                    projectId: 'project-1',
                    provider: 'claude',
                    launchId: 'launch-1',
                    name: 'agent-endpoint',
                    permissionClass: 'standard',
                    messaging: {
                        deliveryMode: 'pull',
                        health: 'ready',
                        reason: 'pull_ready',
                        checkedAt: 1,
                        nextAction: 'none',
                    },
                },
            }).success,
        ).toBe(false);
    });

    it('rejects an unrecognized operation name', () => {
        expect(
            runtimeHostControlRequestSchema.safeParse({
                type: 'host-control.request',
                id: 'request-1',
                operation: 'agent-endpoint.destroy',
                params: {},
            }).success,
        ).toBe(false);
    });
});

describe('runtimeHostControlReplySchema', () => {
    it('requires a result only on the ok branch and an error only on the failure branch', () => {
        expect(
            runtimeHostControlReplySchema.safeParse({
                type: 'host-control.reply',
                id: 'request-1',
                ok: true,
                result: { activated: true },
            }).success,
        ).toBe(true);
        expect(
            runtimeHostControlReplySchema.safeParse({
                type: 'host-control.reply',
                id: 'request-1',
                ok: false,
                error: { code: 'VALIDATION', message: 'invalid launch id' },
            }).success,
        ).toBe(true);
        expect(
            runtimeHostControlReplySchema.safeParse({
                type: 'host-control.reply',
                id: 'request-1',
                ok: false,
                result: { activated: true },
            }).success,
        ).toBe(false);
    });
});
