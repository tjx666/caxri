import type { AgentProvider } from '@caxri/protocol';
import { agentProviderIds } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { ACTIVE_GAP_MS, UsageAccumulator } from '../accumulator';
import type { ClaudeMessageUsage } from '../parsers';
import {
    claudeUsageParser,
    codexUsageParser,
    grokUsageParser,
    usageKeyDigest,
    usageParserFor,
} from '../parsers';

const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const HOUR_SECONDS = T0 / 1000;

function claudeLine(at: number, id: string, usage: Record<string, unknown>, model = 'claude-x') {
    return JSON.stringify({
        type: 'assistant',
        timestamp: new Date(at).toISOString(),
        requestId: `request-${id}`,
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
        expect(record.tokens).toEqual([[HOUR_SECONDS, 0, 11, 41, 100, 0, 0, 0, 0]]);
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

        expect(accumulator.toRecord().tokens).toEqual([[HOUR_SECONDS, 0, 0, 0, 0, 50, 50, 0, 0]]);
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

    it('files a request by its whole input context so a long-context tier can apply', () => {
        const accumulator = new UsageAccumulator();
        const parser = claudeUsageParser(accumulator);
        parser.line(claudeLine(T0, 'm1', { input_tokens: 10, cache_read_input_tokens: 190_000 }));
        parser.line(
            claudeLine(T0, 'm2', {
                input_tokens: 10,
                cache_read_input_tokens: 190_000,
                cache_creation_input_tokens: 20_000,
                output_tokens: 1,
            }),
        );
        // Growth of a long-context message stays in its tier.
        parser.line(
            claudeLine(T0 + 1000, 'm2', {
                input_tokens: 10,
                cache_read_input_tokens: 190_000,
                cache_creation_input_tokens: 20_000,
                output_tokens: 9,
            }),
        );

        expect(accumulator.toRecord().tokens).toEqual([
            [HOUR_SECONDS, 0, 10, 0, 190_000, 0, 0, 0, 128],
            [HOUR_SECONDS, 0, 10, 9, 190_000, 20_000, 0, 0, 200],
        ]);
    });

    it('skips messages an earlier transcript counts, growth included, and records every digest', () => {
        const copied = usageKeyDigest('claude', 'm1:request-m1');
        const accumulator = new UsageAccumulator();
        const parser = claudeUsageParser(accumulator, {
            isCountedElsewhere: (digest) => digest === copied,
        });
        // `claude --resume <id> --fork-session` copies m1 with its IDs and timestamp unchanged.
        parser.line(claudeLine(T0, 'm1', { input_tokens: 10, output_tokens: 5 }));
        parser.line(claudeLine(T0, 'm1', { input_tokens: 10, output_tokens: 40 }));
        parser.line(claudeLine(T0 + 1000, 'm2', { input_tokens: 1, output_tokens: 2 }));

        const record = accumulator.toRecord();
        expect(record.tokens).toEqual([[HOUR_SECONDS, 0, 1, 2, 0, 0, 0, 0, 0]]);
        expect(record.keys).toEqual([copied, usageKeyDigest('claude', 'm2:request-m2')]);
    });

    it("counts once the parent message a forked subagent's side file repeats", () => {
        const accumulator = new UsageAccumulator();
        const claudeMessages = new Map<string, ClaudeMessageUsage>();
        const main = claudeUsageParser(accumulator, { claudeMessages });
        const side = claudeUsageParser(accumulator, { claudeMessages, isSideStream: true });
        main.line(claudeLine(T0, 'parent', { input_tokens: 10, output_tokens: 50 }));
        main.finish();
        side.line(claudeLine(T0, 'parent', { input_tokens: 10, output_tokens: 45 }));
        side.line(claudeLine(T0 + 1000, 'child', { input_tokens: 3, output_tokens: 4 }));

        const record = accumulator.toRecord();
        expect(record.tokens).toEqual([[HOUR_SECONDS, 0, 13, 54, 0, 0, 0, 0, 0]]);
        // Side files never claim a digest: a fork copies main transcripts.
        expect(record.keys).toEqual([usageKeyDigest('claude', 'parent:request-parent')]);
    });
});

function codexTotalsAt(at: number, input: number) {
    return codexLine(at, 'event_msg', {
        type: 'token_count',
        info: {
            total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 0 },
        },
    });
}

function inputTokens(accumulator: UsageAccumulator): number {
    return accumulator.toRecord().tokens.reduce((sum, bucket) => sum + bucket[2], 0);
}

describe('codexUsageParser', () => {
    /**
     * Codex releases from June to August 2026 replayed the parent's totals at the head of a forked subagent rollout,
     * which counted the parent's whole history again.
     */
    it("skips the parent's totals a forked rollout replays before its own first request", () => {
        const accumulator = new UsageAccumulator();
        const parser = codexUsageParser(accumulator);
        parser.line(codexLine(T0, 'session_meta', { id: 'child', forked_from_id: 'parent' }));
        parser.line(codexTotalsAt(T0 + 5000, 100));
        parser.line(codexTotalsAt(T0 + 5010, 200));
        parser.line(codexTotalsAt(T0 + 5030, 300));
        parser.line(codexTotalsAt(T0 + 12_000, 350));

        expect(inputTokens(accumulator)).toBe(50);
    });

    it("counts each request's own usage when the running total continues another rollout's history", () => {
        const accumulator = new UsageAccumulator();
        const parser = codexUsageParser(accumulator);
        const request = (total: number, last: number) =>
            codexLine(T0, 'event_msg', {
                type: 'token_count',
                info: {
                    total_token_usage: { input_tokens: total, cached_input_tokens: 0 },
                    last_token_usage: { input_tokens: last, cached_input_tokens: 0 },
                },
            });
        // A forked thread's first total includes the parent's 1000 tokens.
        parser.line(request(1100, 100));
        // A rate-limit refresh repeats the event without a new request.
        parser.line(request(1100, 100));
        parser.line(request(1150, 50));

        expect(inputTokens(accumulator)).toBe(150);
    });

    it('counts a forked rollout from zero when it opens with its own request', () => {
        const accumulator = new UsageAccumulator();
        const parser = codexUsageParser(accumulator);
        parser.line(codexLine(T0, 'session_meta', { id: 'child', forked_from_id: 'parent' }));
        parser.line(codexTotalsAt(T0 + 6000, 100));
        parser.flush?.();
        expect(inputTokens(accumulator)).toBe(100);

        parser.line(codexTotalsAt(T0 + 6500, 150));
        expect(inputTokens(accumulator)).toBe(150);
    });

    it("keeps a forked rollout's first request when a rate-limit refresh repeats it within a second", () => {
        const accumulator = new UsageAccumulator();
        const parser = codexUsageParser(accumulator);
        parser.line(codexLine(T0, 'session_meta', { id: 'child', forked_from_id: 'parent' }));
        parser.line(codexTotalsAt(T0 + 6000, 100));
        parser.line(codexTotalsAt(T0 + 6200, 100));
        parser.line(codexTotalsAt(T0 + 9000, 150));

        expect(inputTokens(accumulator)).toBe(150);
    });

    it('prices requests at the processing tier the thread settings name', () => {
        const accumulator = new UsageAccumulator();
        const parser = codexUsageParser(accumulator);
        parser.line(
            codexLine(T0, 'event_msg', {
                type: 'thread_settings_applied',
                thread_settings: { service_tier: 'priority' },
            }),
        );
        parser.line(codexTotalsAt(T0, 100));
        // A settings event without a tier leaves it unchanged.
        parser.line(
            codexLine(T0, 'event_msg', { type: 'thread_settings_applied', thread_settings: {} }),
        );
        parser.line(codexTotalsAt(T0, 150));
        parser.line(
            codexLine(T0, 'event_msg', {
                type: 'thread_settings_applied',
                thread_settings: { service_tier: 'default' },
            }),
        );
        parser.line(codexTotalsAt(T0, 160));

        expect(accumulator.toRecord().tokens).toEqual([
            [HOUR_SECONDS, 0, 10, 0, 0, 0, 0, 0, 0],
            [HOUR_SECONDS, 0, 150, 0, 0, 0, 0, 0, 0, null, 'priority'],
        ]);
    });

    it('attributes cumulative totals as deltas under the current model', () => {
        const accumulator = new UsageAccumulator();
        const parser = codexUsageParser(accumulator);
        parser.line(codexLine(T0, 'turn_context', { model: 'gpt-x' }));
        parser.line(codexTotals(100, 40, 10));
        // A repeated total (a rate-limit refresh) adds nothing.
        parser.line(codexTotals(100, 40, 10));
        parser.line(codexTotals(150, 60, 30));

        expect(accumulator.toRecord().tokens).toEqual([[HOUR_SECONDS, 0, 90, 30, 60, 0, 0, 0, 0]]);
    });

    it('treats a shrinking total as a new baseline instead of new usage', () => {
        const accumulator = new UsageAccumulator();
        const parser = codexUsageParser(accumulator);
        parser.line(codexTotals(100, 0, 10));
        parser.line(codexTotals(20, 0, 2));
        parser.line(codexTotals(25, 0, 3));

        expect(accumulator.toRecord().tokens).toEqual([[HOUR_SECONDS, 0, 105, 11, 0, 0, 0, 0, 0]]);
    });

    it("files each delta under the latest request's whole context", () => {
        const accumulator = new UsageAccumulator();
        const parser = codexUsageParser(accumulator);
        parser.line(
            codexLine(T0, 'event_msg', {
                type: 'token_count',
                info: {
                    total_token_usage: { input_tokens: 300_000, cached_input_tokens: 0 },
                    last_token_usage: { input_tokens: 280_000 },
                },
            }),
        );

        expect(accumulator.toRecord().tokens[0][8]).toBe(272);
    });

    it("takes a continuation file's first total as the baseline it repeats", () => {
        const accumulator = new UsageAccumulator();
        const parser = codexUsageParser(accumulator, { isContinuation: true });
        // A reverted thread's new rollout opens with the whole thread's cumulative total.
        parser.line(codexTotals(20_000, 0, 500));
        parser.line(codexTotals(20_100, 0, 520));

        expect(accumulator.toRecord().tokens).toEqual([[HOUR_SECONDS, 0, 100, 20, 0, 0, 0, 0, 0]]);
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

function grokTurnCompleted(promptId: string, extra: Record<string, unknown> = {}) {
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
                            ...extra,
                        },
                    },
                },
            },
        },
    });
}

describe('grokUsageParser', () => {
    it('counts each prompt once and separates cache tokens from input', () => {
        const accumulator = new UsageAccumulator();
        const parser = grokUsageParser(accumulator);
        parser.line(grokTurnCompleted('p1'));
        parser.line(grokTurnCompleted('p1'));

        expect(accumulator.toRecord().tokens).toEqual([[HOUR_SECONDS, 0, 30, 7, 60, 10, 0, 3, 0]]);
    });

    it("keeps Grok's own cost and the per-call context apart from list-priced turns", () => {
        const accumulator = new UsageAccumulator();
        const parser = grokUsageParser(accumulator);
        parser.line(grokTurnCompleted('p1', { costUsdTicks: 25_000_000, modelCalls: 1 }));
        parser.line(grokTurnCompleted('p2', { costUsdTicks: 5_000_000 }));
        parser.line(grokTurnCompleted('p3', { inputTokens: 900_000, modelCalls: 3 }));

        expect(accumulator.toRecord().tokens).toEqual([
            [HOUR_SECONDS, 0, 60, 14, 120, 20, 0, 6, 0, 30_000_000],
            [HOUR_SECONDS, 0, 899_930, 7, 60, 10, 0, 3, 272],
        ]);
    });

    it('skips a turn a resumed or forked session copied from an earlier one', () => {
        const accumulator = new UsageAccumulator();
        const copied = usageKeyDigest('grok', 'p1');
        const parser = grokUsageParser(accumulator, {
            isCountedElsewhere: (digest) => digest === copied,
        });
        parser.line(grokTurnCompleted('p1'));
        parser.line(grokTurnCompleted('p2'));

        const record = accumulator.toRecord();
        expect(record.tokens).toEqual([[HOUR_SECONDS, 0, 30, 7, 60, 10, 0, 3, 0]]);
        expect(record.keys).toEqual([copied, usageKeyDigest('grok', 'p2')]);
    });
});

describe('usageParserFor', () => {
    /**
     * Keyed by `AgentProvider` so a newly catalogued provider fails to compile here until its routing is pinned.
     */
    const ownTranscriptLine: Record<AgentProvider, string> = {
        claude: claudeLine(T0, 'm1', { input_tokens: 10, output_tokens: 5 }),
        codex: codexTotals(100, 40, 20),
        grok: grokTurnCompleted('p1'),
    };
    it.each(agentProviderIds)('counts usage only from %s transcript records', (provider) => {
        for (const [source, line] of Object.entries(ownTranscriptLine)) {
            const accumulator = new UsageAccumulator();
            const parser = usageParserFor(provider, accumulator);
            parser.line(line);
            parser.finish();
            expect(accumulator.toRecord().tokens.length > 0, source).toBe(source === provider);
        }
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
