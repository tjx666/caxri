import type { AgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentChatDockSummary, isAgentChatDockFolded } from '../agent-chat-dock-summary';

const snapshot = (overrides: Partial<AgentChatSnapshot> = {}): AgentChatSnapshot =>
    ({
        status: 'ready',
        activeTurnId: undefined,
        items: [],
        operation: undefined,
        requests: [],
        turns: [],
        tasks: [],
        terminalId: 'term-1',
        ...overrides,
    }) as unknown as AgentChatSnapshot;

const goal = {
    objective: 'Ship',
    status: 'active',
    timeUsedSeconds: 0,
    tokensUsed: 0,
    updatedAt: 0,
};
const options = { isSavedCopy: false, provider: 'Claude Code', queueCount: 0 };

describe('agentChatDockSummary', () => {
    it('is empty for a saved copy or without a snapshot', () => {
        expect(agentChatDockSummary(undefined, options).segments).toEqual([]);
        expect(
            agentChatDockSummary(snapshot({ goal } as never), { ...options, isSavedCopy: true }),
        ).toEqual({ segments: [], isStacked: false });
    });

    it('does not count a single row as stacked', () => {
        expect(agentChatDockSummary(snapshot({ goal } as never), options)).toEqual({
            segments: ['Pursuing goal'],
            isStacked: false,
        });
    });

    it('lists the goal and the queue in dock order', () => {
        expect(
            agentChatDockSummary(snapshot({ goal } as never), { ...options, queueCount: 3 }),
        ).toEqual({ segments: ['Pursuing goal', 'Queued 3'], isStacked: true });
    });
});

describe('isAgentChatDockFolded', () => {
    it('folds only a stacked dock with the keyboard up and the user not expanding it', () => {
        const base = { isExpanded: false, isKeyboardShown: true, isStacked: true };
        expect(isAgentChatDockFolded(base)).toBe(true);
        expect(isAgentChatDockFolded({ ...base, isExpanded: true })).toBe(false);
        expect(isAgentChatDockFolded({ ...base, isKeyboardShown: false })).toBe(false);
        expect(isAgentChatDockFolded({ ...base, isStacked: false })).toBe(false);
    });
});
