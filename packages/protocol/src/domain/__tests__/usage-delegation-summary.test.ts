import { describe, expect, it } from 'vitest';

import { methods } from '../../registry/method-registry';

describe('usage.delegationSummary', () => {
    it('is an owner-only read that no Agent or paired phone can call', () => {
        expect(methods['usage.delegationSummary']).toMatchObject({
            owner: 'server',
            effect: 'read',
            principal: 'owner',
            requiredCapabilities: ['desktop'],
        });
        expect(methods['usage.delegationSummary'].requiredCapabilities).not.toContain(
            'agents.delegate',
        );
    });

    it('rejects extra fields and caps the per-child list', () => {
        const { result, params } = methods['usage.delegationSummary'];
        const base = {
            delegatedCostUsd: 0,
            delegatedSessions: 0,
            isPartial: false,
            isActive: false,
            isScanPending: false,
            children: [],
        };

        expect(params.safeParse({ sessionId: 's', extra: 1 }).success).toBe(false);
        expect(result.safeParse({ ...base, extra: 1 }).success).toBe(false);
        expect(
            result.safeParse({
                ...base,
                children: Array.from({ length: 1001 }, (_, index) => ({
                    sessionId: `s${index}`,
                    costUsd: 0,
                    isPartial: false,
                    isActive: false,
                    sessionCount: 1,
                })),
            }).success,
        ).toBe(false);
    });

    it('lets a session cost leave its own figure unknown', () => {
        const { result } = methods['usage.sessionCost'];

        expect(result.safeParse({ delegatedCostUsd: 0.1, delegatedSessions: 2 }).success).toBe(
            true,
        );
        expect(result.parse({ costUsd: 0, isPartial: false })).toEqual({
            costUsd: 0,
            isPartial: false,
        });
    });
});
