import { describe, expect, it } from 'vitest';

import { ACTIVE_GAP_MS, UsageAccumulator } from '../accumulator';
import { claudeUsageParser, codexUsageParser, grokUsageParser } from '../parsers';

const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const HOUR_SECONDS = T0 / 1000;

function claudeLine(at: number, id: string, usage: Record<string, unknown>, model = 'claude-x') {
    return JSON.stringify({
        type: 'assistant',
        timestamp: new Date(at).toISOString(),
        message: { id, model, usage },
    });
}

function codexLine(at: number, type: string, payload: Record<string, unknown>) {
    return JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload });
}

function codexTotals(input: number, cached: number, output: number) {
    return codexLine(T0, 'event_msg', {
        type: 'token_count',
        info: {
            total_token_usage: {
                input_tokens: input,
                cached_input_tokens: cached,
                output_tokens: output,
            },
        },
    });
}

describe('claudeUsageParser', () => {
    it('merges streamed records of one message by per-field maximum', () => {
        const accumulator = new UsageAccumulator();
        const parser = claudeUsageParser(accumulator);
        parser.line(claudeLine(T0, 'm1', { input_tokens: 10, output_tokens: 5 }));
        parser.line(
            claudeLine(T0 + 1000, 'm1', {
                input_tokens: 10,
                output_tokens: 40,
                cache_read_input_tokens: 100,
            }),
        );
        parser.line(claudeLine(T0 + 2000, 'm2', { input_tokens: 1, output_tokens: 1 }));
        parser.finish();

        const record = accumulator.toRecord();
        expect(record.models).toEqual(['claude-x']);
        expect(record.tokens).toEqual([[HOUR_SECONDS, 0, 11, 41, 100, 0, 0, 0]]);
        expect(record.activity).toEqual([[HOUR_SECONDS, 2000]]);
    });

    it('splits one-hour cache writes and skips synthetic messages', () => {
        const accumulator = new UsageAccumulator();
        const parser = claudeUsageParser(accumulator);
        parser.line(
            claudeLine(T0, 'm1', {
                cache_creation_input_tokens: 50,
                cache_creation: { ephemeral_1h_input_tokens: 80 },
            }),
        );
        parser.line(claudeLine(T0, 'm2', { input_tokens: 9 }, '<synthetic>'));

        expect(accumulator.toRecord().tokens).toEqual([[HOUR_SECONDS, 0, 0, 0, 0, 50, 50, 0]]);
    });

    it('counts side-stream tokens without active time', () => {
        const accumulator = new UsageAccumulator();
        const parser = claudeUsageParser(accumulator, { isSideStream: true });
        parser.line(claudeLine(T0, 'm1', { output_tokens: 3 }));
        parser.line(claudeLine(T0 + 1000, 'm2', { output_tokens: 3 }));

        const record = accumulator.toRecord();
        expect(record.activity).toEqual([]);
        expect(record.tokens[0][3]).toBe(6);
    });
});

describe('codexUsageParser', () => {
    it('attributes cumulative totals as deltas under the current model', () => {
        const accumulator = new UsageAccumulator();
        const parser = codexUsageParser(accumulator);
        parser.line(codexLine(T0, 'turn_context', { model: 'gpt-x' }));
        parser.line(codexTotals(100, 40, 10));
        // A repeated total (a rate-limit refresh) adds nothing.
        parser.line(codexTotals(100, 40, 10));
        parser.line(codexTotals(150, 60, 30));

        expect(accumulator.toRecord().tokens).toEqual([[HOUR_SECONDS, 0, 90, 30, 60, 0, 0, 0]]);
    });

    it('treats a shrinking total as a new baseline instead of new usage', () => {
        const accumulator = new UsageAccumulator();
        const parser = codexUsageParser(accumulator);
        parser.line(codexTotals(100, 0, 10));
        parser.line(codexTotals(20, 0, 2));
        parser.line(codexTotals(25, 0, 3));

        expect(accumulator.toRecord().tokens).toEqual([[HOUR_SECONDS, 0, 105, 11, 0, 0, 0, 0]]);
    });

    it('keeps the latest rate-limit observation', () => {
        const accumulator = new UsageAccumulator();
        const parser = codexUsageParser(accumulator);
        parser.line(
            codexLine(T0, 'event_msg', {
                type: 'token_count',
                rate_limits: {
                    plan_type: 'pro',
                    primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1_800_000_000 },
                },
            }),
        );

        expect(accumulator.toRecord().rateLimits).toEqual({
            observedAt: T0,
            planType: 'pro',
            windows: [{ windowMinutes: 300, usedPercent: 12.5, resetsAt: 1_800_000_000_000 }],
        });
    });
});

describe('grokUsageParser', () => {
    function turnCompleted(promptId: string) {
        return JSON.stringify({
            timestamp: HOUR_SECONDS,
            params: {
                update: {
                    sessionUpdate: 'turn_completed',
                    prompt_id: promptId,
                    usage: {
                        modelUsage: {
                            'grok-x': {
                                inputTokens: 100,
                                cachedReadTokens: 60,
                                cacheCreationTokens: 10,
                                outputTokens: 7,
                                reasoningTokens: 3,
                            },
                        },
                    },
                },
            },
        });
    }

    it('counts each prompt once and separates cache tokens from input', () => {
        const accumulator = new UsageAccumulator();
        const parser = grokUsageParser(accumulator);
        parser.line(turnCompleted('p1'));
        parser.line(turnCompleted('p1'));

        expect(accumulator.toRecord().tokens).toEqual([[HOUR_SECONDS, 0, 30, 7, 60, 10, 0, 3]]);
    });
});

describe('UsageAccumulator', () => {
    it('counts only gaps within the active window and never across streams', () => {
        const accumulator = new UsageAccumulator();
        accumulator.markActivity(T0);
        accumulator.markActivity(T0 + 60_000);
        accumulator.markActivity(T0 + 60_000 + ACTIVE_GAP_MS + 1);
        accumulator.endStream();
        accumulator.markActivity(T0 + 120_000);

        const record = accumulator.toRecord();
        expect(record.activity).toEqual([[HOUR_SECONDS, 60_000]]);
        expect(record.firstAt).toBe(T0);
        expect(record.lastAt).toBe(T0 + 60_000 + ACTIVE_GAP_MS + 1);
    });
});
