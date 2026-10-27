import type { AgentChatItem, AgentChatTurn } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatReturnAnchorTurnId,
    isAgentChatReturnAnchorAbove,
    isAgentChatReturnHintShown,
    turnsFinishedDuringAbsence,
} from '../agent-chat-return-boundary';

const window = { boundary: 1000, capturedAt: 2000 };

function turn(id: string, startedAt: number, durationMs: number, status = 'completed') {
    return { id, status, startedAt, durationMs } as AgentChatTurn;
}

describe('turnsFinishedDuringAbsence', () => {
    it('counts turns by their end time inside the absence, not by epoch', () => {
        const turns = [
            turn('before', 100, 200),
            turn('straddles-leave', 900, 400),
            turn('inside', 1200, 300),
            turn('after-return', 1900, 500),
        ];
        expect(turnsFinishedDuringAbsence(turns, window).map((item) => item.id)).toEqual([
            'straddles-leave',
            'inside',
        ]);
    });

    it('skips running turns and turns without timing', () => {
        const turns = [
            { id: 'running', status: 'running', startedAt: 1100 } as AgentChatTurn,
            { id: 'replayed', status: 'completed' } as AgentChatTurn,
        ];
        expect(turnsFinishedDuringAbsence(turns, window)).toEqual([]);
    });
});

describe('agentChatReturnAnchorTurnId', () => {
    const turns = [turn('t1', 100, 100), turn('t2', 1100, 100)];

    it('points at the first missed turn when its prompt is loaded', () => {
        const items = [
            { id: 'u1', type: 'userMessage', turnId: 't1' },
            { id: 'u2', type: 'userMessage', turnId: 't2' },
        ] as AgentChatItem[];
        expect(agentChatReturnAnchorTurnId(items, turns, window)).toBe('t2');
    });

    it('points at a missed turn no prompt opened, as one a background task started', () => {
        const items = [
            { id: 'u1', type: 'userMessage', turnId: 't1' },
            { id: 'r2', type: 'agentMessage', turnId: 't2', text: 'done', streaming: false },
        ] as AgentChatItem[];
        expect(agentChatReturnAnchorTurnId(items, turns, window)).toBe('t2');
    });

    it('is undefined when nothing was missed or the missed turn is not loaded', () => {
        const items = [{ id: 'u1', type: 'userMessage', turnId: 't1' }] as AgentChatItem[];
        expect(agentChatReturnAnchorTurnId(items, [turn('t1', 100, 100)], window)).toBeUndefined();
        expect(agentChatReturnAnchorTurnId(items, turns, window)).toBeUndefined();
    });
});

describe('isAgentChatReturnAnchorAbove', () => {
    const view = { top: 100 };

    it('treats a prompt whose end is still on screen as in view, so the reply below it is visible', () => {
        expect(isAgentChatReturnAnchorAbove({ bottom: 130 }, view)).toBe(false);
    });

    it('is above once the prompt ends at or above the view top', () => {
        expect(isAgentChatReturnAnchorAbove({ bottom: 100 }, view)).toBe(true);
        expect(isAgentChatReturnAnchorAbove({ bottom: 40 }, view)).toBe(true);
    });
});

describe('isAgentChatReturnHintShown', () => {
    it('shows one missed turn only while its prompt is above the view', () => {
        expect(
            isAgentChatReturnHintShown({ count: 1, isAnchorAbove: true, isLatestInView: true }),
        ).toBe(true);
        expect(
            isAgentChatReturnHintShown({ count: 1, isAnchorAbove: false, isLatestInView: true }),
        ).toBe(false);
    });

    it('gives the bottom slot to Jump to latest once the latest entry leaves the view', () => {
        expect(
            isAgentChatReturnHintShown({ count: 3, isAnchorAbove: true, isLatestInView: false }),
        ).toBe(false);
    });

    it('reports two or more turns whose first prompt is not loaded', () => {
        expect(
            isAgentChatReturnHintShown({
                count: 2,
                isAnchorAbove: undefined,
                isLatestInView: true,
            }),
        ).toBe(true);
        expect(
            isAgentChatReturnHintShown({
                count: 1,
                isAnchorAbove: undefined,
                isLatestInView: true,
            }),
        ).toBe(false);
    });

    it('shows nothing when no turn was missed', () => {
        expect(
            isAgentChatReturnHintShown({ count: 0, isAnchorAbove: true, isLatestInView: true }),
        ).toBe(false);
    });
});
