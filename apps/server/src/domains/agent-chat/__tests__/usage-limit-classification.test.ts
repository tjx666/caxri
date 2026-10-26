import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import { emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    claudeRejectedUsageLimit,
    ClaudeUsageLimitTracker,
} from '../continuation/claude-usage-limit';
import {
    codexTurnFailure,
    CodexUsageLimits,
    isCodexUsageLimitError,
} from '../continuation/codex-usage-limit';

const NOW_SECONDS = 1_772_445_600;

function claudeEvent(fields: Partial<SDKRateLimitInfo>): SDKRateLimitInfo {
    return { status: 'rejected', resetsAt: NOW_SECONDS + 3_600, ...fields };
}

describe('Claude usage-limit classification', () => {
    it('reads a rejected window as used up, unless extra usage still covers it', () => {
        expect(claudeRejectedUsageLimit(claudeEvent({ rateLimitType: 'five_hour' }))).toEqual({
            window: 'session',
            resetsAt: (NOW_SECONDS + 3_600) * 1000,
        });
        expect(claudeRejectedUsageLimit(claudeEvent({ rateLimitType: 'seven_day_opus' }))).toEqual(
            expect.objectContaining({ window: 'weekly' }),
        );
        expect(
            claudeRejectedUsageLimit(claudeEvent({ rateLimitType: 'overage', resetsAt: 0 })),
        ).toEqual({ window: 'unknown' });
        expect(
            claudeRejectedUsageLimit(
                claudeEvent({ rateLimitType: 'five_hour', overageStatus: 'allowed' }),
            ),
        ).toBeUndefined();
        expect(
            claudeRejectedUsageLimit(claudeEvent({ status: 'allowed_warning', utilization: 0.9 })),
        ).toBeUndefined();
    });

    it('remembers used-up windows until allowed again or reset, preferring the weekly one', () => {
        let now = NOW_SECONDS * 1000;
        const tracker = new ClaudeUsageLimitTracker(() => now);
        expect(tracker.current()).toBeUndefined();
        tracker.observe(claudeEvent({ rateLimitType: 'five_hour' }));
        tracker.observe(
            claudeEvent({ rateLimitType: 'seven_day', resetsAt: NOW_SECONDS + 86_400 }),
        );
        expect(tracker.current()?.window).toBe('weekly');
        tracker.observe(claudeEvent({ rateLimitType: 'seven_day', status: 'allowed' }));
        expect(tracker.current()?.window).toBe('session');
        now += 3_600_000;
        expect(tracker.current()).toBeUndefined();
    });
});

describe('Codex usage-limit classification', () => {
    it('tells usageLimitExceeded apart from other Codex errors', () => {
        expect(isCodexUsageLimitError({ codexErrorInfo: 'usageLimitExceeded' })).toBe(true);
        expect(isCodexUsageLimitError({ codexErrorInfo: { usageLimitExceeded: {} } })).toBe(true);
        expect(isCodexUsageLimitError({ codexErrorInfo: 'rateLimitExceeded' })).toBe(false);
        expect(isCodexUsageLimitError({ codexErrorInfo: 'responseStreamDisconnected' })).toBe(
            false,
        );
        expect(isCodexUsageLimitError({ message: 'overloaded' })).toBe(false);
        expect(isCodexUsageLimitError(null)).toBe(false);
    });

    it('names the used-up window from the general limit and ignores retried errors', () => {
        const now = NOW_SECONDS * 1000;
        const limits = new CodexUsageLimits();
        expect(limits.usageLimit(now)).toEqual({ window: 'unknown' });
        expect(
            limits.onNotification('account/rateLimits/updated', {
                rateLimits: {
                    limitId: 'codex_other_model',
                    primary: { usedPercent: 100, windowDurationMins: 10_080 },
                },
            }),
        ).toBe(true);
        expect(limits.usageLimit(now)).toEqual({ window: 'unknown' });
        limits.onNotification('account/rateLimits/updated', {
            rateLimits: {
                limitId: 'codex',
                primary: {
                    usedPercent: 100,
                    windowDurationMins: 300,
                    resetsAt: NOW_SECONDS + 600,
                },
                secondary: { usedPercent: 40, windowDurationMins: 10_080 },
            },
        });
        expect(limits.usageLimit(now)).toEqual({
            window: 'session',
            resetsAt: (NOW_SECONDS + 600) * 1000,
        });
        // A sparse update keeps the other window's reading.
        limits.onNotification('account/rateLimits/updated', {
            rateLimits: { secondary: { usedPercent: 100, windowDurationMins: 10_080 } },
        });
        expect(limits.usageLimit(now).window).toBe('weekly');
        expect(limits.onNotification('turn/started', {})).toBe(false);

        const error = { codexErrorInfo: 'usageLimitExceeded', message: 'limit' };
        expect(limits.errorLimit({ willRetry: true, error })).toBeUndefined();
        expect(limits.errorLimit({ willRetry: false, error: { message: 'x' } })).toBeUndefined();
        expect(limits.errorLimit({ willRetry: false, error })?.window).toBe('weekly');
    });

    it('reports a turn whose notice carries a used-up limit as a billing failure', () => {
        const snapshot = emptyAgentChatSnapshot('terminal-1');
        expect(codexTurnFailure(snapshot, 'turn-1')).toBe('provider_failed');
        const failed = {
            ...snapshot,
            items: [
                {
                    id: 'turn-1:error',
                    turnId: 'turn-1',
                    type: 'notice' as const,
                    kind: 'error' as const,
                    usageLimit: { window: 'session' as const },
                },
            ],
        };
        expect(codexTurnFailure(failed, 'turn-1')).toBe('billing_error');
    });
});
