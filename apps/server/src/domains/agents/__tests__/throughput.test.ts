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

    it('splits the session by model and speed tier, moving a re-reported response with it', () => {
        const accumulator = new ThroughputAccumulator();
        accumulator.response({ ...response('a', 100, 1_000), model: 'm1' });
        accumulator.response({ ...response('b', 200, 1_000), model: 'm1', speed: 'fast' });
        accumulator.response({ ...response('c', 300, 1_000), model: 'm1', speed: 'fast' });
        // The same response re-reported after its model was learned no longer counts under the old variant.
        accumulator.response({ ...response('c', 400, 2_000), model: 'm2', speed: 'fast' });
        expect(accumulator.snapshot('codex')?.byModel).toEqual([
            { model: 'm1', durationMs: 1_000, outputTokens: 100, responseCount: 1 },
            { model: 'm1', speed: 'fast', durationMs: 1_000, outputTokens: 200, responseCount: 1 },
            { model: 'm2', speed: 'fast', durationMs: 2_000, outputTokens: 400, responseCount: 1 },
        ]);
        expect(accumulator.snapshot('codex')?.samples.at(-1)).toEqual({
            completedAt: 0,
            durationMs: 2_000,
            outputTokens: 400,
            model: 'm2',
            speed: 'fast',
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
