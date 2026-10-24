import type { AgentChatItem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { buildAgentChatTimeline } from '../agent-chat-timeline';

const command = (id: string, status: 'completed' | 'running'): AgentChatItem => ({
    id,
    turnId: 't1',
    type: 'command',
    command: `echo ${id}`,
    output: '',
    status,
});

describe('agentChatWorkEntry', () => {
    it('shows a settled lone call as its own row instead of a one-call summary', () => {
        const [work] = buildAgentChatTimeline({
            items: [
                command('c1', 'completed'),
                {
                    id: 'a1',
                    turnId: 't1',
                    type: 'agentMessage',
                    text: 'Checked.',
                    streaming: false,
                },
            ],
            turns: [{ id: 't1', status: 'running' }],
            activeTurnId: 't1',
        });
        if (work.kind !== 'work') throw new Error('expected a work entry');
        expect(work.isOpen).toBeUndefined();
        expect(work.summarized).toEqual([]);
        expect(work.rows.map((item) => item.id)).toEqual(['c1']);
    });

    it('merges back-to-back thoughts into one row titled by the latest', () => {
        const thought = (id: string, text: string): AgentChatItem => ({
            id,
            turnId: 't1',
            type: 'reasoning',
            text,
            streaming: false,
        });
        const [work] = buildAgentChatTimeline({
            items: [
                thought('r1', '**Reading**'),
                thought('r2', '**Planning**'),
                command('c1', 'completed'),
                { id: 'a1', turnId: 't1', type: 'agentMessage', text: 'Done.', streaming: false },
            ],
            turns: [{ id: 't1', status: 'running' }],
            activeTurnId: 't1',
        });
        if (work.kind !== 'work') throw new Error('expected a work entry');
        expect(work.summarized).toHaveLength(2);
        expect(work.summarized[0]).toMatchObject({ type: 'reasoning' });
        expect(work.summarized[0]?.type === 'reasoning' && work.summarized[0].text).toContain(
            'Planning',
        );
    });
});
