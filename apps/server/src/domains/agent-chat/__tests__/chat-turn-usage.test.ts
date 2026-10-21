import { describe, expect, it } from 'vitest';

import type { ChatTurnResponse } from '../chat-turn-usage';
import { ChatTurnUsage, claudeTurnResponse, codexTurnResponse } from '../chat-turn-usage';

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
