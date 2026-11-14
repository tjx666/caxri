import type { AgentChatItem, AgentChatTurn } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { buildAgentChatTimeline } from '../agent-chat-timeline';

const turns: AgentChatTurn[] = [{ id: 't1', status: 'completed', durationMs: 52_000 }];

const fold = (replyText: string) =>
    buildAgentChatTimeline(
        [
            { id: 'u', turnId: 't1', type: 'userMessage', text: 'Ship it' },
            {
                id: 'c1',
                turnId: 't1',
                type: 'command',
                command: 'gh run watch',
                output: '',
                status: 'completed',
            },
            { id: 'a1', turnId: 't1', type: 'agentMessage', text: replyText, streaming: false },
        ] satisfies AgentChatItem[],
        turns,
        undefined,
    ).find((entry) => entry.kind === 'turn');

describe('a finished turn fold open by default', () => {
    it('opens behind a one-line final reply', () => {
        expect(fold('CI on main passed, all done.')).toMatchObject({ isOpenByDefault: true });
    });

    it('stays closed behind a reply of several lines', () => {
        expect(fold('Merged.\n\nCI on main passed too.')).not.toHaveProperty('isOpenByDefault');
    });
});
