import { describe, expect, it } from 'vitest';

import { ThroughputAccumulator } from '../../../throughput';
import { createClaudeThroughputScanner } from '../throughput';

const BASE = Date.parse('2026-10-10T08:00:00.000Z');

function at(seconds: number): string {
    return new Date(BASE + seconds * 1_000).toISOString();
}

const prompt = (seconds: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
        timestamp: at(seconds),
        type: 'user',
        message: { role: 'user', content: 'Explain the build' },
        ...extra,
    });
const toolResult = (seconds: number, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
        timestamp: at(seconds),
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' }] },
        ...extra,
    });
const assistant = (
    seconds: number,
    id: string,
    outputTokens: number,
    extra: Record<string, unknown> = {},
) =>
    JSON.stringify({
        timestamp: at(seconds),
        type: 'assistant',
        message: { id, model: 'claude-opus-5-5', usage: { output_tokens: outputTokens } },
        ...extra,
    });

function scan(lines: string[]): ThroughputAccumulator {
    const scanner = createClaudeThroughputScanner();
    const sink = new ThroughputAccumulator();
    for (const value of lines) scanner.scanLine(value, sink);
    return sink;
}

describe('createClaudeThroughputScanner', () => {
    it("tags each response with its message's model and usage speed", () => {
        const snapshot = scan([
            prompt(0),
            assistant(2, 'msg-1', 300),
            toolResult(3),
            JSON.stringify({
                timestamp: at(5),
                type: 'assistant',
                message: {
                    id: 'msg-2',
                    model: 'claude-opus-5-5',
                    usage: { output_tokens: 200, speed: 'fast' },
                },
            }),
        ]).snapshot('claude');
        expect(snapshot?.byModel).toEqual([
            {
                model: 'claude-opus-5-5',
                durationMs: 2_000,
                outputTokens: 300,
                responseCount: 1,
            },
            {
                model: 'claude-opus-5-5',
                speed: 'fast',
                durationMs: 2_000,
                outputTokens: 200,
                responseCount: 1,
            },
        ]);
    });

    it('measures each message from its last input to its last content block', () => {
        const snapshot = scan([
            prompt(0),
            assistant(2, 'msg-1', 300),
            assistant(3, 'msg-1', 300),
            assistant(4, 'msg-1', 300),
            toolResult(5),
            assistant(9, 'msg-2', 200),
        ]).snapshot('claude');
        expect(snapshot?.samples).toEqual([
            {
                completedAt: BASE + 4_000,
                durationMs: 4_000,
                outputTokens: 300,
                model: 'claude-opus-5-5',
            },
            {
                completedAt: BASE + 9_000,
                durationMs: 4_000,
                outputTokens: 200,
                model: 'claude-opus-5-5',
            },
        ]);
        expect(snapshot?.session).toEqual({
            durationMs: 8_000,
            outputTokens: 500,
            responseCount: 2,
        });
    });

    it('keeps a message whole when its streamed tool call returns before the message finishes', () => {
        const snapshot = scan([
            prompt(0),
            assistant(2, 'msg-1', 900),
            toolResult(3),
            assistant(6, 'msg-1', 900),
            toolResult(7),
            assistant(10, 'msg-1', 900),
        ]).snapshot('claude');
        expect(snapshot?.samples).toEqual([
            expect.objectContaining({
                completedAt: BASE + 10_000,
                durationMs: 10_000,
                outputTokens: 900,
            }),
        ]);
    });

    it('skips a message whose only input precedes the previous message instead of borrowing its start', () => {
        const snapshot = scan([
            prompt(0),
            assistant(2, 'msg-1', 100),
            toolResult(3),
            assistant(4, 'msg-1', 100),
            // No input after msg-1 ended, so msg-2's request start is unknown.
            assistant(8, 'msg-2', 100),
            toolResult(9),
            assistant(10, 'msg-2', 100),
        ]).snapshot('claude');
        expect(snapshot?.samples.map(({ durationMs }) => durationMs)).toEqual([4_000]);
    });

    it('ignores sidechain, API error, and synthetic lines', () => {
        const snapshot = scan([
            prompt(0),
            assistant(1, 'side', 50, { isSidechain: true }),
            assistant(2, 'error', 50, { isApiErrorMessage: true }),
            JSON.stringify({
                timestamp: at(3),
                type: 'assistant',
                message: { id: 'synthetic', model: '<synthetic>', usage: { output_tokens: 5 } },
            }),
            assistant(5, 'msg-1', 100),
        ]).snapshot('claude');
        expect(snapshot?.samples).toEqual([
            expect.objectContaining({
                completedAt: BASE + 5_000,
                durationMs: 5_000,
                outputTokens: 100,
            }),
        ]);
    });

    it('starts a new turn on a real prompt but not on tool results or meta lines', () => {
        const snapshot = scan([
            prompt(0),
            assistant(2, 'msg-1', 100),
            prompt(10),
            assistant(12, 'msg-2', 40),
            toolResult(13),
            prompt(14, { isMeta: true }),
            assistant(16, 'msg-3', 60),
        ]).snapshot('claude');
        expect(snapshot?.turn).toEqual({ durationMs: 4_000, outputTokens: 100, responseCount: 2 });
        expect(snapshot?.session.responseCount).toBe(3);
    });
});
