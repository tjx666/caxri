import { describe, expect, it } from 'vitest';

import { inspectContextCache } from '../context-cache';

const timestamp = '2026-01-01T00:00:00Z';
const activityAt = Date.parse(timestamp);
const codex = (input = 120_000) =>
    JSON.stringify({
        timestamp,
        type: 'event_msg',
        payload: {
            type: 'token_count',
            info: {
                last_token_usage: { input_tokens: input, total_tokens: input + 100 },
                total_token_usage: { input_tokens: 9_000_000 },
            },
        },
    });
interface ClaudeUsageFixture {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}
const claude = (usage: ClaudeUsageFixture) =>
    JSON.stringify({ type: 'assistant', timestamp, message: { usage } });

describe('prompt cache selection evidence', () => {
    it('uses the latest Codex request rather than cumulative usage and tolerates partial records', () => {
        expect(
            inspectContextCache('codex', [codex(240_000), codex(), '{partial'].join('\n')),
        ).toEqual({
            status: 'measured',
            usage: { activityAt, contextTokens: 120_000, ttlMinutes: 30 },
        });
    });
    it('retains the native zero-input fallback', () => {
        expect(inspectContextCache('codex', codex(0))).toMatchObject({
            usage: { contextTokens: 100 },
        });
    });
    it.each(['compacted', 'context_compacted'])('invalidates stale Codex usage at %s', (type) => {
        const boundary = JSON.stringify(
            type === 'compacted' ? { type } : { type: 'event_msg', payload: { type } },
        );
        expect(inspectContextCache('codex', `${codex()}\n${boundary}`)).toEqual({
            status: 'already_compacted',
        });
        expect(inspectContextCache('codex', `${boundary}\n${codex()}`)).toMatchObject({
            status: 'measured',
        });
    });
    it.each([
        [5, 'ephemeral_5m_input_tokens'],
        [60, 'ephemeral_1h_input_tokens'],
    ] as const)(
        'uses Claude %i-minute creation evidence and adds all input categories',
        (ttlMinutes, field) => {
            expect(
                inspectContextCache(
                    'claude',
                    claude({
                        input_tokens: 1000,
                        cache_read_input_tokens: 100_000,
                        cache_creation_input_tokens: 2000,
                        cache_creation: { [field]: 2000 },
                    }),
                ),
            ).toEqual({
                status: 'measured',
                usage: { activityAt, contextTokens: 103_000, ttlMinutes },
            });
        },
    );
    it('carries earlier TTL evidence into a cache-read-only response, stopping at compaction', () => {
        const creation = claude({
            input_tokens: 10,
            cache_creation: { ephemeral_5m_input_tokens: 100 },
        });
        const latest = claude({ cache_read_input_tokens: 80_000 });
        const boundary = JSON.stringify({
            type: 'system',
            subtype: 'compact_boundary',
            compactMetadata: { postTokens: 5000 },
        });
        expect(inspectContextCache('claude', `${creation}\n${latest}`)).toMatchObject({
            usage: { contextTokens: 80_000, ttlMinutes: 5 },
        });
        expect(inspectContextCache('claude', `${latest}\n${boundary}`)).toEqual({
            status: 'already_compacted',
        });
        expect(inspectContextCache('claude', `${creation}\n${boundary}\n${latest}`)).toMatchObject({
            usage: { ttlMinutes: 60 },
        });
    });
    it.each(['codex', 'claude', 'grok'] as const)('fails closed without %s usage', (provider) => {
        expect(inspectContextCache(provider, 'invalid\n{}')).toEqual({
            status: 'usage_unavailable',
        });
    });
});
