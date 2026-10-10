import { describe, expect, it } from 'vitest';

import type { ThroughputResponse, ThroughputSink } from '../../../throughput';
import { ThroughputAccumulator } from '../../../throughput';
import { createCodexThroughputScanner } from '../throughput';

const BASE = Date.parse('2026-10-10T01:54:00.000Z');

function at(seconds: number): string {
    return new Date(BASE + seconds * 1_000).toISOString();
}

function line(seconds: number, type: string, payload: Record<string, unknown> = {}): string {
    return JSON.stringify({ timestamp: at(seconds), type, payload });
}

const taskStarted = (seconds: number) => line(seconds, 'event_msg', { type: 'task_started' });
const userMessage = (seconds: number) =>
    line(seconds, 'response_item', { type: 'message', role: 'user' });
const reasoning = (seconds: number) => line(seconds, 'response_item', { type: 'reasoning' });
const toolCall = (seconds: number) => line(seconds, 'response_item', { type: 'custom_tool_call' });
const toolOutput = (seconds: number) =>
    line(seconds, 'response_item', { type: 'custom_tool_call_output' });
const usage = (seconds: number, responseId: string, outputTokens: number) =>
    line(seconds, 'token_usage_record', {
        response_id: responseId,
        usage: { output_tokens: outputTokens, reasoning_output_tokens: 10 },
    });

function scan(lines: string[]): { responses: ThroughputResponse[]; sink: ThroughputAccumulator } {
    const scanner = createCodexThroughputScanner();
    const sink = new ThroughputAccumulator();
    const responses: ThroughputResponse[] = [];
    const recording: ThroughputSink = {
        response: (response) => {
            responses.push(response);
            sink.response(response);
        },
        turnStarted: () => sink.turnStarted(),
        turnTimeToFirstToken: (milliseconds) => sink.turnTimeToFirstToken(milliseconds),
    };
    for (const value of lines) scanner.scanLine(value, recording);
    return { responses, sink };
}

describe('createCodexThroughputScanner', () => {
    it('times a response from its last input to its last generated item, not to the usage record', () => {
        const { responses } = scan([
            taskStarted(0),
            userMessage(1),
            reasoning(5),
            toolCall(11),
            // Codex already ran the streamed tool call before it wrote the usage record.
            usage(13, 'resp-1', 500),
            toolOutput(14),
            reasoning(16),
            toolCall(19),
            usage(19.1, 'resp-2', 250),
        ]);
        expect(responses).toEqual([
            { completedAt: BASE + 11_000, durationMs: 10_000, key: 'resp-1', outputTokens: 500 },
            { completedAt: BASE + 19_000, durationMs: 5_000, key: 'resp-2', outputTokens: 250 },
        ]);
    });

    it('does not restart the clock when a parallel tool result lands while the response is still generating', () => {
        const { responses } = scan([
            taskStarted(0),
            userMessage(1),
            toolCall(4),
            toolOutput(5),
            toolCall(9),
            usage(9.1, 'resp-1', 400),
        ]);
        expect(responses).toEqual([
            expect.objectContaining({ durationMs: 8_000, outputTokens: 400 }),
        ]);
    });

    it('skips a response without a recorded start instead of estimating one', () => {
        const { responses } = scan([
            // A resumed rollout: the response's start was written before this file region.
            reasoning(3),
            usage(4, 'resp-1', 100),
            // A duplicate usage record for an already measured response.
            taskStarted(10),
            reasoning(12),
            usage(13, 'resp-2', 100),
            usage(13.5, 'resp-2', 100),
            // Compaction produces usage but no generated item.
            line(20, 'compacted'),
            usage(25, 'resp-3', 900),
        ]);
        expect(responses.map(({ key }) => key)).toEqual(['resp-2']);
    });

    it('reports the turn time to first token from task_complete and keeps it while the next turn runs', () => {
        const { sink } = scan([
            taskStarted(0),
            reasoning(4),
            usage(5, 'resp-1', 400),
            line(6, 'event_msg', { type: 'task_complete', time_to_first_token_ms: 2_500 }),
        ]);
        expect(sink.snapshot('codex')).toMatchObject({
            turn: { durationMs: 4_000, outputTokens: 400, responseCount: 1 },
            turnTimeToFirstTokenMs: 2_500,
        });
        sink.turnStarted();
        expect(sink.snapshot('codex')?.turnTimeToFirstTokenMs).toBe(2_500);
    });

    it('ignores malformed lines', () => {
        const { responses } = scan(['', 'not json', '{"type":', taskStarted(0), '[]']);
        expect(responses).toEqual([]);
    });
});
