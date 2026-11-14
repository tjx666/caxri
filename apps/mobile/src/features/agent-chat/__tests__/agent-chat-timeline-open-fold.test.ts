import type { AgentChatItem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { buildAgentChatTimeline } from '../agent-chat-timeline';
import { toggleAgentChatExpansion } from '../agent-chat-turn-expansion';

const items: AgentChatItem[] = [
    { id: 'u1', turnId: 't1', type: 'userMessage', text: 'Go' },
    {
        id: 'c1',
        turnId: 't1',
        type: 'command',
        command: 'gh run watch',
        output: '',
        status: 'completed',
    },
    { id: 'a1', turnId: 't1', type: 'agentMessage', text: 'Done.', streaming: false },
];
const snapshot = { items, turns: [{ id: 't1', status: 'completed' as const }] };

describe('a finished turn fold open by default', () => {
    it('shows the work of a turn that ended on a one-line reply until the user folds it', () => {
        const open = buildAgentChatTimeline(snapshot);
        expect(open.map((entry) => entry.id)).toEqual([
            'u1',
            'turn:t1',
            'work:c1',
            'a1',
            'reply-actions:t1',
        ]);
        expect(open[1]).toMatchObject({ fold: 'expanded' });

        const folded = buildAgentChatTimeline(snapshot, toggleAgentChatExpansion(new Set(), 't1'));
        expect(folded.map((entry) => entry.id)).toEqual([
            'u1',
            'turn:t1',
            'a1',
            'reply-actions:t1',
        ]);
        expect(folded[1]).toMatchObject({ fold: 'collapsed' });
    });
});
