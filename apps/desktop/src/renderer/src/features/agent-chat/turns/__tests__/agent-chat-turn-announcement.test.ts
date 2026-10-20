import { describe, expect, it } from 'vitest';

import { agentChatTurnAnnouncement } from '../agent-chat-turn-announcement';

describe('agentChatTurnAnnouncement', () => {
    it('names how the ended turn finished', () => {
        expect(agentChatTurnAnnouncement('t1', [{ id: 't1', status: 'completed' }])).toBe(
            'Reply ready',
        );
        expect(agentChatTurnAnnouncement('t1', [{ id: 't1', status: 'failed' }])).toBe(
            'Turn failed',
        );
        expect(agentChatTurnAnnouncement('t1', [{ id: 't1', status: 'interrupted' }])).toBe(
            'Stopped',
        );
    });

    it('waits while the turn still reads as running, and stays silent without one', () => {
        expect(agentChatTurnAnnouncement('t1', [{ id: 't1', status: 'running' }])).toBeUndefined();
        expect(agentChatTurnAnnouncement('t1', [])).toBeUndefined();
        expect(
            agentChatTurnAnnouncement(undefined, [{ id: 't1', status: 'completed' }]),
        ).toBeUndefined();
    });
});
