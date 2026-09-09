import { describe, expect, it } from 'vitest';

import { extractCodexDelegationUsage } from '../delegation-usage';

const evidence = { sessionId: 'synthetic-session', turnId: 'owned', promptDigest: 'a'.repeat(64) };
const event = (type: string, extra = {}) =>
    JSON.stringify({ type: 'event_msg', payload: { type, ...extra } });
const start = (turnId = 'owned') => event('task_started', { turn_id: turnId });
const end = (turnId = 'owned') => event('task_complete', { turn_id: turnId });
const meta = JSON.stringify({ type: 'session_meta', payload: { id: evidence.sessionId } });
const count = (input: number, output: number, cached = 0) =>
    event('token_count', {
        info: {
            total_token_usage: {
                input_tokens: input,
                output_tokens: output,
                cached_input_tokens: cached,
                reasoning_output_tokens: 0,
                total_tokens: input + output,
            },
        },
    });
const usage = (rows: string[]) => extractCodexDelegationUsage(rows.join('\n'), evidence);

describe('Codex exact-task usage', () => {
    it('subtracts the prior task rather than summing duplicate cumulative snapshots', () => {
        expect(
            usage([
                start('earlier'),
                count(100, 20, 30),
                end('earlier'),
                start(),
                count(140, 30, 40),
                count(140, 30, 40),
                count(170, 50, 50),
                end(),
            ]),
        ).toEqual({
            source: 'provider',
            scope: 'main-thread',
            inputTokens: 70,
            outputTokens: 30,
            cacheReadTokens: 20,
            reasoningTokens: 0,
            totalTokens: 100,
        });
    });
    it('uses zero only for a proven fresh first task', () => {
        expect(usage([meta, start(), count(40, 10), end()])).toMatchObject({
            inputTokens: 40,
            outputTokens: 10,
        });
        expect(usage([start(), count(40, 10), end()])).toBeUndefined();
        expect(
            usage([meta, start('earlier'), end('earlier'), start(), count(40, 10), end()]),
        ).toBeUndefined();
    });
    it('does not require the beginning of a large file when a prior counter proves the baseline', () => {
        expect(usage([count(100, 20), start(), count(110, 25), end()])).toMatchObject({
            inputTokens: 10,
            outputTokens: 5,
        });
    });
    it.each([
        [meta, start(), count(40, 10), 'malformed synthetic record', end()],
        [count(40, 10), 'malformed synthetic record', start(), count(50, 15), end()],
        [meta, start(), end()],
        [meta, start(), count(40, 10), start('other'), end()],
        [meta, start(), count(40, 10), end('other')],
        [meta, start(), count(40, 10), count(20, 5), end()],
        [meta, start(), count(40, 10), event('context_compacted'), end()],
        [meta, start(), count(-1, 10), end()],
        [meta, start(), count(Number.MAX_SAFE_INTEGER + 1, 10), end()],
    ])('leaves missing or contradictory accounting unknown (%#)', (...rows) => {
        expect(usage(rows)).toBeUndefined();
    });
});
