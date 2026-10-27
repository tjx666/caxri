import type { AgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { ChatTurnResponse } from '../turn-usage';
import { ChatTurnUsage, claudeTurnResponse, codexTurnResponse } from '../turn-usage';

function spend(usage: ChatTurnUsage, turnId: string | undefined, response?: ChatTurnResponse) {
    const operation = usage.add(turnId, response);
    return operation?.op === 'state' ? operation.state.turnUsage : undefined;
}

function claude(id: string, usage: Record<string, unknown>, model = 'claude-sonnet-4-5') {
    return claudeTurnResponse({ id, model, usage });
}

function codex(total: number, input: number, cached: number, output: number, isFast = false) {
    const parameters = {
        tokenUsage: {
            total: { totalTokens: total },
            last: { inputTokens: input, cachedInputTokens: cached, outputTokens: output },
        },
    };
    return codexTurnResponse(parameters, 'gpt-5', isFast);
}

describe('ChatTurnUsage', () => {
    it('counts a Claude message once across its repeated content block frames', () => {
        const usage = new ChatTurnUsage();
        const frame = { input_tokens: 1000, output_tokens: 10 };
        spend(usage, 'turn-1', claude('msg-1', frame));
        expect(spend(usage, 'turn-1', claude('msg-1', frame))).toBeUndefined();
        const grown = spend(usage, 'turn-1', claude('msg-1', { ...frame, output_tokens: 50 }));
        expect(grown).toMatchObject({ turnId: 'turn-1', requests: 1, totalTokens: 1050 });
        // 1000 input at $3/M plus 50 output at $15/M.
        expect(grown?.costUsd).toBeCloseTo(0.003_75, 8);
    });

    it('adds each new response, a subagent one included, as a step', () => {
        const usage = new ChatTurnUsage();
        spend(usage, 'turn-1', claude('msg-1', { input_tokens: 100, output_tokens: 10 }));
        const subagent = claude('sub-1', {
            input_tokens: 5,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 40,
            output_tokens: 20,
        });
        expect(spend(usage, 'turn-1', subagent)).toMatchObject({ requests: 2, totalTokens: 375 });
    });

    it('starts over when a response arrives for another turn', () => {
        const usage = new ChatTurnUsage();
        spend(usage, 'turn-1', claude('msg-1', { input_tokens: 100, output_tokens: 10 }));
        const next = spend(usage, 'turn-2', claude('msg-1', { input_tokens: 7, output_tokens: 3 }));
        expect(next).toMatchObject({ turnId: 'turn-2', requests: 1, totalTokens: 10 });
    });

    it("carries an active goal's spend across its turns and starts over for another or a cleared goal", () => {
        const usage = new ChatTurnUsage();
        const active = {
            objective: 'ship it',
            status: 'active' as const,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            updatedAt: 1,
        };
        let snapshot: Pick<AgentChatSnapshot, 'goal' | 'goalUsage'> = { goal: active };
        /**
         * Applies the goal's spend the way the reducer does, so the next response adds to it.
         */
        const goalSpend = (turnId: string, response: ChatTurnResponse | undefined) => {
            const operation = usage.add(turnId, response, snapshot);
            const state = operation?.op === 'state' ? operation.state : undefined;
            if (state?.goalUsage) snapshot = { ...snapshot, goalUsage: state.goalUsage };
            return state;
        };
        goalSpend('turn-1', claude('msg-1', { input_tokens: 100, output_tokens: 10 }));
        const second = goalSpend('turn-2', claude('msg-2', { input_tokens: 7, output_tokens: 3 }));
        expect(second?.goalUsage).toMatchObject({
            objective: 'ship it',
            requests: 2,
            totalTokens: 120,
        });
        // A paused goal spends nothing, while the turn's own figures still grow.
        snapshot = { ...snapshot, goal: { ...active, status: 'paused' } };
        const paused = goalSpend('turn-2', claude('msg-3', { input_tokens: 5, output_tokens: 5 }));
        expect(paused?.turnUsage).toMatchObject({ requests: 2, totalTokens: 20 });
        expect(paused).not.toHaveProperty('goalUsage');
        snapshot = { ...snapshot, goal: active };
        const resumed = goalSpend('turn-3', claude('msg-4', { input_tokens: 1, output_tokens: 1 }));
        expect(resumed?.goalUsage).toMatchObject({ requests: 3, totalTokens: 122 });
        snapshot = { ...snapshot, goal: { ...active, objective: 'next goal' } };
        const other = goalSpend('turn-3', claude('msg-5', { input_tokens: 2, output_tokens: 2 }));
        expect(other?.goalUsage).toMatchObject({
            objective: 'next goal',
            requests: 1,
            totalTokens: 4,
        });
        // A cleared goal takes its spend along, so the same objective set again counts from zero.
        snapshot = { goal: { ...active, objective: 'next goal' } };
        const again = goalSpend('turn-4', claude('msg-6', { input_tokens: 3, output_tokens: 3 }));
        expect(again?.goalUsage).toMatchObject({ requests: 1, totalTokens: 6 });
    });

    it('counts tokens but no cost for a model missing from the price list', () => {
        const usage = new ChatTurnUsage();
        const response = claude('msg-1', { input_tokens: 10, output_tokens: 5 }, 'unknown-model');
        expect(spend(usage, 'turn-1', response)).toEqual({
            turnId: 'turn-1',
            requests: 1,
            totalTokens: 15,
        });
    });

    it('ignores a response while no turn is active and a synthetic Claude message', () => {
        const usage = new ChatTurnUsage();
        const frame = { input_tokens: 10, output_tokens: 5 };
        expect(spend(usage, undefined, claude('msg-1', frame))).toBeUndefined();
        expect(claude('msg-1', frame, '<synthetic>')).toBeUndefined();
    });

    it('sums Codex requests by their own usage and skips a repeated notification', () => {
        const usage = new ChatTurnUsage();
        spend(usage, 'turn-1', codex(1100, 1000, 800, 100));
        expect(spend(usage, 'turn-1', codex(1100, 1000, 800, 100))).toBeUndefined();
        const fast = spend(usage, 'turn-1', codex(2300, 1100, 1000, 100, true));
        expect(fast).toMatchObject({ requests: 2, totalTokens: 2300 });
        // First: 200 input, 800 cached, 100 output. Second, at the priority tier's 2x: 100 input, 1000 cached, 100 output.
        const first = 200 * 1.25e-6 + 800 * 1.25e-7 + 100 * 1e-5;
        const second = (100 * 1.25e-6 + 1000 * 1.25e-7 + 100 * 1e-5) * 2;
        expect(fast?.costUsd).toBeCloseTo(first + second, 10);
    });

    it('keeps Codex requests apart when the running total is missing', () => {
        const usage = new ChatTurnUsage();
        const last = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 };
        const parameters = { tokenUsage: { total: {}, last } };
        spend(usage, 'turn-1', codexTurnResponse(parameters, 'gpt-5', false));
        const second = spend(usage, 'turn-1', codexTurnResponse(parameters, 'gpt-5', false));
        expect(second).toMatchObject({ requests: 2, totalTokens: 220 });
    });
});
