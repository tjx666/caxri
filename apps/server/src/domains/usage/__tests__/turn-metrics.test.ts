import type { AgentChatTurn, AgentThroughput, AgentThroughputSample } from '@caxri/protocol';
import { AGENT_THROUGHPUT_SAMPLE_LIMIT } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
    chatTurnMetricsOperation,
    chatTurnThroughput,
    recordChatTurnMetrics,
} from '../turn-metrics';

const turn: AgentChatTurn = {
    id: 'turn-2',
    status: 'completed',
    startedAt: 10_000,
    durationMs: 60_000,
};

function sample(completedAt: number, outputTokens: number, durationMs = 2_000) {
    return { completedAt, outputTokens, durationMs } satisfies AgentThroughputSample;
}

const NO_TURN_TOTAL = { outputTokens: 0, durationMs: 0, responseCount: 0 };

function throughput(
    samples: AgentThroughputSample[],
    current: AgentThroughput['turn'] = NO_TURN_TOTAL,
): Pick<AgentThroughput, 'samples' | 'turn'> {
    return { samples, turn: current };
}

describe('chatTurnThroughput', () => {
    it("sums only the responses that completed inside the turn's own window", () => {
        const samples = [
            // The previous turn's last response.
            sample(9_000, 900),
            sample(20_000, 300, 3_000),
            // Written a moment after the Chat's own end-of-turn clock.
            sample(72_000, 200, 1_000),
            // A queued follow-up that already started the next turn.
            sample(90_000, 500),
        ];
        expect(chatTurnThroughput(throughput(samples), turn)).toEqual({
            outputTokens: 500,
            durationMs: 4_000,
        });
    });

    it('falls back to the running turn total once the sample window dropped earlier responses', () => {
        const samples = Array.from({ length: AGENT_THROUGHPUT_SAMPLE_LIMIT }, (_, index) =>
            sample(11_000 + index * 1_000, 10),
        );
        const current = { outputTokens: 4_000, durationMs: 40_000, responseCount: 40 };
        expect(chatTurnThroughput(throughput(samples, current), turn)).toBe(current);
    });

    it('has nothing to say for a turn without a recorded window or without measured responses', () => {
        const unstarted = { ...turn, startedAt: undefined };
        const measured = throughput([sample(20_000, 10)]);
        expect(chatTurnThroughput(measured, unstarted)).toBeUndefined();
        expect(chatTurnThroughput(throughput([]), turn)).toBeUndefined();
        expect(chatTurnThroughput(null, turn)).toBeUndefined();
    });
});

describe('chatTurnMetricsOperation', () => {
    const turns: AgentChatTurn[] = [{ id: 'turn-1', status: 'completed' }, turn];

    it("writes the turn's speed and its own cost onto the turn, leaving the others untouched", () => {
        const operation = chatTurnMetricsOperation(
            { turns },
            'turn-2',
            { turnId: 'turn-2', requests: 3, totalTokens: 9_000, costUsd: 0.42 },
            throughput([sample(20_000, 300, 3_000)]),
        );
        expect(operation).toEqual({
            op: 'state',
            state: {
                turns: [
                    turns[0],
                    {
                        ...turn,
                        metrics: { outputTokens: 300, generationMs: 3_000, costUsd: 0.42 },
                    },
                ],
            },
        });
    });

    it("ignores another turn's running cost and records nothing when nothing was measured", () => {
        expect(
            chatTurnMetricsOperation(
                { turns },
                'turn-2',
                { turnId: 'turn-3', requests: 1, totalTokens: 10, costUsd: 0.01 },
                null,
            ),
        ).toBeUndefined();
    });
});

describe('recordChatTurnMetrics', () => {
    it('keeps the cost captured at the end of the turn even when the next turn replaced it during the read', async () => {
        const state = {
            turns: [turn],
            turnUsage: { turnId: 'turn-2', requests: 1, totalTokens: 100, costUsd: 0.1 },
        };
        const apply = vi.fn();
        await recordChatTurnMetrics(
            {
                apply,
                isCurrent: () => true,
                read: () => state,
                readThroughput: () => {
                    state.turnUsage = {
                        turnId: 'turn-3',
                        requests: 1,
                        totalTokens: 5,
                        costUsd: 0.5,
                    };
                    return Promise.reject(new Error('transcript unavailable'));
                },
            },
            'turn-2',
        );
        expect(apply).toHaveBeenCalledWith([
            { op: 'state', state: { turns: [{ ...turn, metrics: { costUsd: 0.1 } }] } },
        ]);
    });
});
