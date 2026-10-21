import { describe, expect, it } from 'vitest';

import { agentChatTurnMetrics, formatAgentChatTurnCost } from '../agent-chat-turn-metrics';

describe('agentChatTurnMetrics', () => {
    it('lists steps, tokens, and cost in order', () => {
        expect(agentChatTurnMetrics({ requests: 12, totalTokens: 12_345, costUsd: 0.42 })).toEqual([
            { kind: 'steps', value: '12', figure: { value: 12, fractionDigits: 0, suffix: '' } },
            {
                kind: 'tokens',
                value: '12.3k',
                figure: { value: 12.3, fractionDigits: 1, suffix: 'k' },
            },
            { kind: 'cost', value: '0.42', figure: { value: 0.42, fractionDigits: 2, suffix: '' } },
        ]);
    });

    it('animates the same figure the text shows', () => {
        const [tokens, cost] = agentChatTurnMetrics({
            requests: 1,
            totalTokens: 389_012,
            costUsd: 0.003_45,
        });
        expect(tokens).toMatchObject({
            value: '389k',
            figure: { value: 389, fractionDigits: 0, suffix: 'k' },
        });
        expect(cost).toMatchObject({
            value: '0.0034',
            figure: { value: 0.0034, fractionDigits: 4 },
        });
    });

    it('leaves out a single step, zero figures, and an unpriced cost', () => {
        expect(agentChatTurnMetrics({ requests: 1, totalTokens: 900 })).toEqual([
            { kind: 'tokens', value: '900', figure: { value: 900, fractionDigits: 0, suffix: '' } },
        ]);
        expect(agentChatTurnMetrics({ requests: 0, totalTokens: 0, costUsd: 0 })).toEqual([]);
        expect(agentChatTurnMetrics(undefined)).toEqual([]);
    });
});

describe('formatAgentChatTurnCost', () => {
    it('keeps four decimals below a cent and two from there', () => {
        expect(formatAgentChatTurnCost(0.003_42)).toBe('0.0034');
        expect(formatAgentChatTurnCost(0.01)).toBe('0.01');
        expect(formatAgentChatTurnCost(1.5)).toBe('1.50');
    });
});
