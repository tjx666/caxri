import { describe, expect, it } from 'vitest';

import type { AgentChatWorkItem } from '../agent-chat-work';
import {
    agentChatReasoningTitle,
    describeAgentChatWork,
    mergeAgentChatReasoning,
} from '../agent-chat-work';

const command = (id: string): AgentChatWorkItem => ({
    id,
    type: 'command',
    command: 'git status',
    status: 'completed',
    output: '',
});

describe('agentChatReasoningTitle', () => {
    it('names a thought by its latest Codex summary title', () => {
        expect(agentChatReasoningTitle('**Planning the fix**\n\nRead the parser first.')).toEqual({
            title: 'Planning the fix',
            body: 'Read the parser first.',
        });
        const twoParts = '**Reading code**\n\nOpened it.\n\n**Writing tests**\n\nAdded one.';
        expect(agentChatReasoningTitle(twoParts)).toEqual({
            title: 'Writing tests',
            body: twoParts,
        });
        expect(agentChatReasoningTitle('Plain **bold** thought')).toEqual({
            body: 'Plain **bold** thought',
        });
    });

    it('shows the title beside the Thinking verb', () => {
        expect(
            describeAgentChatWork({
                id: 'r',
                type: 'reasoning',
                text: '**Tracing the bug**\n\n',
                streaming: true,
            }),
        ).toEqual({
            kind: 'thought',
            label: 'Thinking',
            subject: 'Tracing the bug',
            isCodeSubject: false,
        });
    });
});

describe('mergeAgentChatReasoning', () => {
    const thought = (id: string, text: string, isStreaming = false): AgentChatWorkItem => ({
        id,
        type: 'reasoning',
        text,
        streaming: isStreaming,
    });

    it('reads back-to-back reasoning as one thought under its first item', () => {
        const merged = mergeAgentChatReasoning([
            thought('a', '**Analyzing**\n\n'),
            thought('b', '**Clarifying**'),
            thought('c', '**Preparing**', true),
            command('x'),
            thought('d', '**Restoring**'),
        ]);
        expect(merged).toEqual([
            thought('a', '**Analyzing**\n\n**Clarifying**\n\n**Preparing**', true),
            command('x'),
            thought('d', '**Restoring**'),
        ]);
        expect(describeAgentChatWork(merged[0]).subject).toBe('Preparing');
    });

    it('returns a list without a reasoning run as it is', () => {
        const items = [thought('a', '**Plan**'), command('x')];
        expect(mergeAgentChatReasoning(items)).toBe(items);
    });
});
