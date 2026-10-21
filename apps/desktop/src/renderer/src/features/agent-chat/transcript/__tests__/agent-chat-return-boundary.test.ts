import type { AgentChatItem, AgentChatTurn } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatReturnAnchorId,
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

describe('agentChatReturnAnchorId', () => {
    const items = [
        { id: 'u1', type: 'userMessage', turnId: 't1' },
        { id: 'u2', type: 'userMessage', turnId: 't2' },
    ] as AgentChatItem[];

    it('points at the prompt of the first missed turn', () => {
        expect(
            agentChatReturnAnchorId(items, [turn('t1', 100, 100), turn('t2', 1100, 100)], window),
        ).toBe('u2');
    });

    it('is undefined when nothing was missed or the prompt is not loaded', () => {
        expect(agentChatReturnAnchorId(items, [turn('t1', 100, 100)], window)).toBeUndefined();
        expect(agentChatReturnAnchorId([], [turn('t2', 1100, 100)], window)).toBeUndefined();
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
