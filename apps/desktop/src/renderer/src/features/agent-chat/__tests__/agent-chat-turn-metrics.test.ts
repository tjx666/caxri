import { describe, expect, it } from 'vitest';

import { agentChatTurnMetrics, formatAgentChatTurnCost } from '../agent-chat-turn-metrics';

describe('agentChatTurnMetrics', () => {
    it('lists steps, tokens, and cost in order', () => {
        expect(agentChatTurnMetrics({ requests: 12, totalTokens: 12_345, costUsd: 0.42 })).toEqual([
            { kind: 'steps', value: '12' },
            { kind: 'tokens', value: '12.3k' },
            { kind: 'cost', value: '0.42' },
        ]);
    });

    it('leaves out a single step, zero figures, and an unpriced cost', () => {
        expect(agentChatTurnMetrics({ requests: 1, totalTokens: 900 })).toEqual([
            { kind: 'tokens', value: '900' },
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
