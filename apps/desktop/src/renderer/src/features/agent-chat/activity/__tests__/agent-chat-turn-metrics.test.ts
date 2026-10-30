import { Gauge, Rabbit, Turtle } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import {
    AGENT_CHAT_SPEED_ICONS,
    agentChatReplyMetrics,
    agentChatTurnMetrics,
    agentChatTurnRate,
    formatAgentChatTurnCost,
} from '../agent-chat-turn-metrics';

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

describe('agentChatReplyMetrics', () => {
    it('reads the speed and the cost, with the totals and the estimate caveat as detail lines', () => {
        expect(
            agentChatReplyMetrics(
                { outputTokens: 3_210, generationMs: 52_000, costUsd: 0.4234 },
                translate,
            ),
        ).toEqual({
            cost: '0.42',
            rate: '62\u{A0}tok/s',
            details: [
                '3,210 tokens in 52s · 62\u{A0}tok/s',
                'Estimated cost of this turn at API list prices: $0.42',
            ],
        });
    });

    it('shows whichever figure the turn has, and nothing for a turn that has neither', () => {
        // Too short to rate: the token count alone would not tell how fast the Agent answered.
        expect(
            agentChatReplyMetrics(
                { outputTokens: 40, generationMs: 100, costUsd: 0.01 },
                translate,
            ),
        ).toMatchObject({ cost: '0.01', rate: undefined });
        expect(
            agentChatReplyMetrics({ outputTokens: 600, generationMs: 10_000 }, translate),
        ).toMatchObject({
            cost: undefined,
            rate: '60\u{A0}tok/s',
        });
        // An unpriced model's zero is not "free".
        expect(agentChatReplyMetrics({ costUsd: 0 }, translate)).toBeUndefined();
        expect(agentChatReplyMetrics(undefined, translate)).toBeUndefined();
    });
});

describe('AGENT_CHAT_SPEED_ICONS', () => {
    it('picks the glyph by speed tier, with the Gauge for an unrecorded one', () => {
        expect(AGENT_CHAT_SPEED_ICONS).toEqual({
            fast: Rabbit,
            standard: Gauge,
            flex: Turtle,
            unknown: Gauge,
        });
    });
});

describe('agentChatTurnRate', () => {
    it('names the tier before the measured totals', () => {
        expect(
            agentChatTurnRate(
                { outputTokens: 3_210, generationMs: 52_000, speed: 'fast' },
                translate,
            ),
        ).toEqual({
            value: '62\u{A0}tok/s',
            speed: 'fast',
            tooltip: 'Fast · 3,210 tokens in 52s · 62\u{A0}tok/s',
        });
    });

    it('leaves out an unrecorded tier and rates nothing too short to measure', () => {
        expect(agentChatTurnRate({ outputTokens: 600, generationMs: 10_000 }, translate)).toEqual({
            value: '60\u{A0}tok/s',
            speed: undefined,
            tooltip: '600 tokens in 10s · 60\u{A0}tok/s',
        });
        expect(
            agentChatTurnRate({ outputTokens: 40, generationMs: 100 }, translate),
        ).toBeUndefined();
        expect(agentChatTurnRate({ costUsd: 0.1 }, translate)).toBeUndefined();
    });
});
