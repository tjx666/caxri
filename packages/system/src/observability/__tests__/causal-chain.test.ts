import { describe, expect, it } from 'vitest';

import { BoundedCausalChain, MAX_CAUSAL_CAPSULES } from '../causal-chain';

describe('BoundedCausalChain', () => {
    it('retains only stable classification and opaque correlation', () => {
        const chain = new BoundedCausalChain();
        const capsule = chain.record({
            code: 'SERVER_UNAVAILABLE',
            context: {
                requestId: '/private/project/secret.ts',
                traceId: 'trace-1',
            },
            owner: 'server-core',
            phase: 'execute',
            reason: 'core-unavailable',
            remediation: 'restart-core',
            retryable: true,
            timestamp: '2026-08-26T00:00:00.000Z',
        });

        expect(capsule).toEqual({
            code: 'SERVER_UNAVAILABLE',
            context: { traceId: 'trace-1' },
            owner: 'server-core',
            phase: 'execute',
            reason: 'core-unavailable',
            remediation: 'restart-core',
            retryable: true,
            schemaVersion: 1,
            timestamp: '2026-08-26T00:00:00.000Z',
        });
        expect(capsule).not.toHaveProperty('message');
        expect(capsule).not.toHaveProperty('payload');
    });

    it('retains only the newest bounded capsules', () => {
        const chain = new BoundedCausalChain();
        for (let index = 0; index < MAX_CAUSAL_CAPSULES + 2; index++) {
            chain.record({
                context: { traceId: `trace-${index}` },
                owner: 'stream',
                phase: 'transfer',
                reason: 'stream-closed',
                remediation: 'reconnect',
                retryable: true,
            });
        }

        expect(chain.snapshot()).toHaveLength(MAX_CAUSAL_CAPSULES);
        expect(chain.snapshot()[0]?.context.traceId).toBe('trace-2');
    });
});
