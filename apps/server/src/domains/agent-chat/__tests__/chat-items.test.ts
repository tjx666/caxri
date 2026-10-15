import type { AgentChatSnapshot } from '@caxri/protocol';
import { applyAgentChatOperation, emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { endedSessionOperations } from '../chat-items';

describe('endedSessionOperations', () => {
    const running: AgentChatSnapshot = {
        ...emptyAgentChatSnapshot('terminal-1'),
        activeTurnId: 'active-turn',
        turns: [
            { id: 'earlier-turn', status: 'completed' },
            { id: 'active-turn', status: 'running' },
        ],
    };

    it('retains user attribution when Stop must force the provider process closed', () => {
        const ended = endedSessionOperations(running, 'user').reduce(
            applyAgentChatOperation,
            running,
        );
        expect(ended.activeTurnId).toBeUndefined();
        expect(ended.turns).toEqual([
            { id: 'earlier-turn', status: 'completed' },
            { id: 'active-turn', status: 'interrupted', interruptionReason: 'user' },
        ]);
    });

    it('leaves an unknown process exit unattributed', () => {
        const ended = endedSessionOperations(running).reduce(applyAgentChatOperation, running);
        expect(ended.turns.at(-1)).toEqual({ id: 'active-turn', status: 'interrupted' });
    });
});
