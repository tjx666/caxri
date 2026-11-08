import { describe, expect, it } from 'vitest';

import { buildAgentChatTimeline } from '../agent-chat-timeline';
import { agentChatTurnTone } from '../agent-chat-turn-tone';

describe('agentChatTurnTone', () => {
    it('tones a failed turn as danger and a stopped one as a warning', () => {
        expect(agentChatTurnTone('completed')).toBe('muted');
        expect(agentChatTurnTone('failed')).toBe('danger');
        expect(agentChatTurnTone('failed', undefined, true)).toBe('muted');
        expect(agentChatTurnTone('interrupted')).toBe('warning');
        expect(agentChatTurnTone('interrupted', 'user')).toBe('muted');
    });
});

describe('a failed turn with a scheduled usage-limit continuation', () => {
    it('marks a failed turn whose usage limit will continue on its own, and only while it waits', () => {
        const footer = (autoContinue?: { status: 'continued' | 'waiting'; at: number }) =>
            buildAgentChatTimeline({
                items: [
                    { id: 'u1', turnId: 't1', type: 'userMessage', text: 'Go' },
                    {
                        id: 'n1',
                        turnId: 't1',
                        type: 'notice',
                        kind: 'error',
                        message: "You've hit your session limit",
                        usageLimit: {
                            window: 'session',
                            resetsAt: 1,
                            ...(autoContinue && { autoContinue }),
                        },
                    },
                ],
                turns: [{ id: 't1', status: 'failed', durationMs: 400 }],
            }).find((entry) => entry.kind === 'turn');
        expect(footer({ status: 'waiting', at: 2 })).toMatchObject({ continuationScheduled: true });
        expect(footer({ status: 'continued', at: 2 })).not.toHaveProperty('continuationScheduled');
        expect(footer()).not.toHaveProperty('continuationScheduled');
    });
});
