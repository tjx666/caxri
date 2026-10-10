import { AGENT_THROUGHPUT_RECENT_RESPONSES, AGENT_THROUGHPUT_SAMPLE_LIMIT } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { ThroughputAccumulator } from '../throughput';

function response(key: string, outputTokens: number, durationMs: number) {
    return { completedAt: 0, durationMs, key, outputTokens };
}

describe('ThroughputAccumulator', () => {
    it('reports nothing until a response is measured', () => {
        expect(new ThroughputAccumulator().snapshot('codex')).toBeNull();
    });

    it('replaces a re-reported response instead of counting it twice', () => {
        const accumulator = new ThroughputAccumulator();
        accumulator.response(response('a', 100, 2_000));
        accumulator.response(response('a', 300, 4_000));
        expect(accumulator.snapshot('claude')).toMatchObject({
            samples: [{ durationMs: 4_000, outputTokens: 300 }],
            session: { durationMs: 4_000, outputTokens: 300, responseCount: 1 },
            turn: { durationMs: 4_000, outputTokens: 300, responseCount: 1 },
        });
    });

    it('keeps a re-reported response from the previous turn out of the new turn', () => {
        const accumulator = new ThroughputAccumulator();
        accumulator.response(response('a', 100, 2_000));
        accumulator.turnStarted();
        accumulator.response(response('b', 50, 1_000));
        expect(accumulator.snapshot('claude')?.turn).toEqual({
            durationMs: 1_000,
            outputTokens: 50,
            responseCount: 1,
        });
    });

    it('weights the recent window by tokens and bounds the retained samples', () => {
        const accumulator = new ThroughputAccumulator();
        for (let index = 0; index < AGENT_THROUGHPUT_SAMPLE_LIMIT + 5; index += 1)
            accumulator.response(response(String(index), index + 1, 1_000));
        const snapshot = accumulator.snapshot('codex');
        expect(snapshot?.samples).toHaveLength(AGENT_THROUGHPUT_SAMPLE_LIMIT);
        expect(snapshot?.recent.responseCount).toBe(AGENT_THROUGHPUT_RECENT_RESPONSES);
        // The last ten responses carry 16..25 tokens, one second each.
        expect(snapshot?.recent).toEqual({
            durationMs: 10_000,
            outputTokens: 205,
            responseCount: 10,
        });
        expect(snapshot?.session.responseCount).toBe(AGENT_THROUGHPUT_SAMPLE_LIMIT + 5);
    });
});
