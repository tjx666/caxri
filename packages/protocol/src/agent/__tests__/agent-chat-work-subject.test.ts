import { describe, expect, it } from 'vitest';

import type { AgentChatWorkItem } from '../agent-chat-work';
import { agentChatWorkSubject, describeAgentChatWork } from '../agent-chat-work';

const message = (summary: string): AgentChatWorkItem => ({
    id: 'm',
    type: 'toolCall',
    name: 'SendMessage',
    summary,
    status: 'completed',
});
const subagent = { kind: 'agent', title: 'Acceptance watcher' } as const;

describe('agentChatWorkSubject', () => {
    it('names a subagent addressed by its generated id by its task title', () => {
        const item = message('to a9fa29d284b88501c: Round 10: Ultra tooltip');
        const presentation = describeAgentChatWork(item);
        // Without the task the id is dropped and only the message remains.
        expect(presentation).toMatchObject({
            label: 'Messaged agent',
            subject: 'Round 10: Ultra tooltip',
        });
        expect(agentChatWorkSubject(item, presentation, subagent)).toBe(
            'Acceptance watcher: Round 10: Ultra tooltip',
        );
    });

    it('keeps a teammate addressed by name', () => {
        const item = message('to researcher: Check the tests');
        const presentation = describeAgentChatWork(item);
        expect(presentation.subject).toBe('researcher: Check the tests');
        expect(agentChatWorkSubject(item, presentation, subagent)).toBe(
            'researcher: Check the tests',
        );
    });

    it('leaves other rows alone', () => {
        const item: AgentChatWorkItem = {
            id: 'r',
            type: 'toolCall',
            name: 'Read',
            summary: '/work/src/app.ts',
            status: 'completed',
        };
        const presentation = describeAgentChatWork(item);
        expect(agentChatWorkSubject(item, presentation, subagent)).toBe(presentation.subject);
    });
});
