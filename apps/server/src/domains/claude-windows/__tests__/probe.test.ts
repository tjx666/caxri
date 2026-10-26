import type { AccountInfo } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { accountGate, usageReading } from '../probe';

const NOW = Date.parse('2026-10-26T06:00:00Z');
const subscription: AccountInfo = {
    email: 'person@example.com',
    organization: 'Example',
    subscriptionType: 'Claude Pro',
    apiProvider: 'firstParty',
};

function usage(fiveHour: unknown, plan: unknown = 'pro', weeklyUsed = 10): Record<string, unknown> {
    return {
        subscription_type: plan,
        rate_limits: {
            five_hour: fiveHour,
            seven_day: { utilization: weeklyUsed, resets_at: '2026-10-30T00:00:00Z' },
        },
    };
}

describe('accountGate', () => {
    it('admits a first-party claude.ai sign-in and keeps only a hash of its identity', () => {
        const gate = accountGate(subscription, {});
        expect(gate).toEqual({ identity: expect.stringMatching(/^[0-9a-f]{64}$/) as string });
        expect(JSON.stringify(gate)).not.toContain('example');
        expect(accountGate({ ...subscription, organization: 'Other' }, {})).not.toEqual(gate);
    });

    it.each([
        ['an API key in the environment', subscription, { ANTHROPIC_API_KEY: 'x' }],
        ['a custom endpoint', subscription, { ANTHROPIC_BASE_URL: 'x' }],
        ['Bedrock', subscription, { CLAUDE_CODE_USE_BEDROCK: '1' }],
        ['a third-party provider', { ...subscription, apiProvider: 'bedrock' }, {}],
        ['an API key helper', { ...subscription, apiKeySource: 'apiKeyHelper' }, {}],
        ['a long-lived token', { ...subscription, tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' }, {}],
    ] as const)('fails closed on %s', (_, account, environment) => {
        expect(accountGate(account as AccountInfo, environment)).toEqual({
            reason: 'authUnsupported',
        });
    });

    it('reports a missing sign-in', () => {
        expect(accountGate(undefined, {})).toEqual({ reason: 'notSignedIn' });
        expect(accountGate({ ...subscription, email: undefined }, {})).toEqual({
            reason: 'notSignedIn',
        });
    });
});

describe('usageReading', () => {
    it('reads an active window, an idle one, and the plan', () => {
        expect(
            usageReading(usage({ utilization: 40, resets_at: '2026-10-26T08:00:00Z' }), NOW),
        ).toEqual({
            planType: 'pro',
            windowResetsAt: Date.parse('2026-10-26T08:00:00Z'),
            isWeeklyLimitReached: false,
        });
        expect(usageReading(usage({ utilization: 0, resets_at: null }), NOW)).toEqual({
            planType: 'pro',
            isWeeklyLimitReached: false,
        });
        expect(
            usageReading(usage({ utilization: 0, resets_at: '2026-10-26T05:00:00Z' }, 'max'), NOW),
        ).toEqual({ planType: 'max', isWeeklyLimitReached: false });
    });

    it('treats a missing 5-hour reading as unavailable, never as an idle window', () => {
        expect(usageReading({ subscription_type: 'pro', rate_limits: null }, NOW)).toEqual({
            reason: 'usageUnavailable',
        });
        expect(usageReading(usage(null), NOW)).toEqual({ reason: 'usageUnavailable' });
        expect(usageReading(undefined, NOW)).toEqual({ reason: 'usageUnavailable' });
    });

    it('fails closed on a plan it cannot confirm and flags a used-up week', () => {
        const idle = { utilization: 0, resets_at: null };
        expect(usageReading(usage(idle, 'team'), NOW)).toEqual({ reason: 'planUnsupported' });
        expect(usageReading(usage(idle, null), NOW)).toEqual({ reason: 'planUnsupported' });
        expect(usageReading(usage(idle, 'max', 100), NOW)).toMatchObject({
            isWeeklyLimitReached: true,
        });
    });
});
