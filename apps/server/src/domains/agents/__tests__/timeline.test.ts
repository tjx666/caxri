import { describe, expect, it } from 'vitest';

import { appendClaudeTimelineRecord } from '../providers/claude/timeline';
import { appendCodexTimelineRecord } from '../providers/codex/timeline';
import { TimelineBuilder } from '../timeline-model';
import { claude } from './timeline.fixture';

describe('provider timeline projection', () => {
    it('associates late Claude tool results, filters injected blocks, and deduplicates native messages', () => {
        const builder = new TimelineBuilder('fixture');
        const records = [
            claude('user', 'prompt', [
                { type: 'text', text: 'Run the check' },
                { type: 'text', text: '<system-reminder>Injected instruction</system-reminder>' },
            ]),
            claude('assistant', 'tool', [
                { type: 'thinking', thinking: 'Private reasoning' },
                {
                    type: 'tool_use',
                    id: 'call-1',
                    name: 'Bash',
                    input: { command: 'printf ready' },
                },
            ]),
            claude('assistant', 'answer', [{ type: 'text', text: 'Ready.' }], {
                message: { id: 'answer-1', content: [{ type: 'text', text: 'Ready.' }] },
            }),
            claude('assistant', 'answer-repeat', [{ type: 'text', text: 'Ready.' }], {
                message: { id: 'answer-1', content: [{ type: 'text', text: 'Ready.' }] },
            }),
            claude('user', 'result', [
                {
                    type: 'tool_result',
                    tool_use_id: 'call-1',
                    content: 'Synthetic result',
                    is_error: true,
                },
            ]),
            { type: 'system', subtype: 'turn_duration', durationMs: 1_250 },
        ];
        records.forEach((record, index) =>
            appendClaudeTimelineRecord(builder, record, index * 100),
        );
        expect(builder.entries.map(({ item }) => item.type)).toEqual([
            'userMessage',
            'toolCall',
            'agentMessage',
            'turnBoundary',
        ]);
        expect(builder.entries[0]?.item).toMatchObject({ text: 'Run the check' });
        expect(builder.entries[1]?.item).toMatchObject({
            summary: 'printf ready',
            status: 'failed',
            detail: 'Synthetic result',
        });
        expect(JSON.stringify(builder.entries)).not.toMatch(
            /Private reasoning|Injected instruction/u,
        );
    });

    it('projects Codex response items without duplicating task-complete answer', () => {
        const builder = new TimelineBuilder('fixture');
        const records = [
            {
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'Run a check' }],
                },
            },
            {
                type: 'response_item',
                payload: {
                    type: 'function_call',
                    name: 'shell_command',
                    call_id: 'call-1',
                    arguments: JSON.stringify({ command: 'printf ready' }),
                },
            },
            {
                type: 'response_item',
                payload: {
                    type: 'function_call_output',
                    call_id: 'call-1',
                    output: 'ready',
                },
            },
            {
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Done.' }],
                },
            },
            { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Done.' } },
        ];
        records.forEach((record, index) => appendCodexTimelineRecord(builder, record, index * 100));
        expect(builder.entries.map(({ item }) => item.type)).toEqual([
            'userMessage',
            'toolCall',
            'agentMessage',
            'turnBoundary',
        ]);
        expect(builder.entries[1]?.item).toMatchObject({
            status: 'succeeded',
            summary: 'printf ready',
        });
    });

    it('removes injected wrappers from Claude tool input and late result detail', () => {
        const builder = new TimelineBuilder('fixture');
        appendClaudeTimelineRecord(
            builder,
            claude('assistant', 'tool', [
                {
                    type: 'tool_use',
                    id: 'call-injected',
                    name: 'Bash',
                    input: { command: '<system-reminder>Hidden command</system-reminder>' },
                },
            ]),
            0,
        );
        appendClaudeTimelineRecord(
            builder,
            claude('user', 'result', [
                {
                    type: 'tool_result',
                    tool_use_id: 'call-injected',
                    content: 'Visible result\n<system-reminder>Hidden result</system-reminder>',
                    is_error: false,
                },
            ]),
            100,
        );
        expect(builder.entries[0]?.item).toMatchObject({
            type: 'toolCall',
            summary: 'Bash',
            detail: 'Visible result',
            status: 'succeeded',
        });
        expect(JSON.stringify(builder.entries)).not.toContain('Hidden');
    });

    it('names the subject of Claude web, agent, and skill tools', () => {
        const builder = new TimelineBuilder('fixture');
        appendClaudeTimelineRecord(
            builder,
            claude('assistant', 'tools', [
                {
                    type: 'tool_use',
                    id: 'call-fetch',
                    name: 'WebFetch',
                    input: { url: 'https://example.com/docs', prompt: 'Summarize' },
                },
                {
                    type: 'tool_use',
                    id: 'call-task',
                    name: 'Task',
                    input: { description: 'Survey the parser', prompt: 'Long prompt' },
                },
                { type: 'tool_use', id: 'call-skill', name: 'Skill', input: { skill: 'commit' } },
                { type: 'tool_use', id: 'call-todo', name: 'TodoWrite', input: { todos: [] } },
            ]),
            0,
        );
        expect(builder.entries.map((entry) => entry.item)).toMatchObject([
            { name: 'WebFetch', summary: 'https://example.com/docs' },
            { name: 'Task', summary: 'Survey the parser' },
            { name: 'Skill', summary: 'commit' },
            { name: 'TodoWrite', summary: 'TodoWrite' },
        ]);
    });

    it('hides Claude sidechain and meta tool activity', () => {
        const builder = new TimelineBuilder('fixture');
        for (const extra of [{ isSidechain: true }, { isMeta: true }])
            appendClaudeTimelineRecord(
                builder,
                claude(
                    'assistant',
                    'hidden',
                    [
                        {
                            type: 'tool_use',
                            id: 'hidden-tool',
                            name: 'Bash',
                            input: { command: 'hidden' },
                        },
                        { type: 'text', text: 'Hidden message' },
                    ],
                    extra,
                ),
                0,
            );
        expect(builder.entries).toEqual([]);
    });

    it('projects a Claude slash-command echo as a systemEvent instead of a userMessage', () => {
        const builder = new TimelineBuilder('fixture');
        appendClaudeTimelineRecord(
            builder,
            claude('user', 'command', [
                {
                    type: 'text',
                    text:
                        '<command-name>/clear</command-name>' +
                        '<local-command-stdout>Conversation cleared.</local-command-stdout>',
                },
            ]),
            0,
        );
        expect(builder.entries).toHaveLength(1);
        expect(builder.entries[0]?.item).toMatchObject({
            type: 'systemEvent',
            kind: 'slashCommand',
            summary: '/clear',
            detail: 'Conversation cleared.',
        });
    });

    it('projects a Codex bash-mode echo as a systemEvent instead of a userMessage', () => {
        const builder = new TimelineBuilder('fixture');
        appendCodexTimelineRecord(
            builder,
            {
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: '<bash-input>printf ready</bash-input><bash-stdout>ready</bash-stdout>',
                        },
                    ],
                },
            },
            0,
        );
        expect(builder.entries).toHaveLength(1);
        expect(builder.entries[0]?.item).toMatchObject({
            type: 'systemEvent',
            kind: 'bashCommand',
            summary: 'printf ready',
            detail: 'ready',
        });
    });

    it('removes injected wrappers from Codex call arguments and output detail', () => {
        const builder = new TimelineBuilder('fixture');
        appendCodexTimelineRecord(
            builder,
            {
                type: 'response_item',
                payload: {
                    type: 'function_call',
                    name: 'shell_command',
                    call_id: 'call-injected',
                    arguments: JSON.stringify({
                        command: '<system-reminder>Hidden command</system-reminder>',
                    }),
                },
            },
            0,
        );
        appendCodexTimelineRecord(
            builder,
            {
                type: 'response_item',
                payload: {
                    type: 'function_call_output',
                    call_id: 'call-injected',
                    output: 'Visible output\n<system-reminder>Hidden output</system-reminder>',
                },
            },
            100,
        );
        expect(builder.entries[0]?.item).toMatchObject({
            type: 'toolCall',
            summary: 'shell_command',
            detail: 'Visible output',
            status: 'succeeded',
        });
        expect(JSON.stringify(builder.entries)).not.toContain('Hidden');
    });
});
