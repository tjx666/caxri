import { describe, expect, it } from 'vitest';

import {
    claudeQuestionAnswers,
    mapClaudeApproval,
    mapClaudeToolUse,
    settleClaudeToolItem,
} from '../claude-items';

describe('Claude item mapping', () => {
    it('maps tools to command, file change, and generic tool rows, hiding the plan and question tools', () => {
        expect(
            mapClaudeToolUse({ id: 't1', name: 'Bash', input: { command: 'ls' } }, 'turn'),
        ).toEqual({
            id: 't1',
            turnId: 'turn',
            type: 'command',
            command: 'ls',
            status: 'running',
            output: '',
        });
        expect(
            mapClaudeToolUse(
                {
                    id: 't2',
                    name: 'Edit',
                    input: { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' },
                },
                'turn',
            ),
        ).toMatchObject({
            type: 'fileChange',
            changes: [{ path: '/p/a.ts', kind: 'update', diff: '@@\n-a\n+b' }],
        });
        expect(
            mapClaudeToolUse(
                { id: 't3', name: 'WebFetch', input: { url: 'https://example.com' } },
                'turn',
            ),
        ).toMatchObject({ type: 'toolCall', name: 'WebFetch', summary: 'https://example.com' });
        expect(
            mapClaudeToolUse({ id: 't4', name: 'TodoWrite', input: {} }, 'turn'),
        ).toBeUndefined();
        expect(
            mapClaudeToolUse({ id: 't5', name: 'AskUserQuestion', input: {} }, 'turn'),
        ).toBeUndefined();
    });

    it('marks a written file as added and a declined tool as declined', () => {
        const item = mapClaudeToolUse(
            { id: 't1', name: 'Write', input: { file_path: '/p/new.ts', content: 'x' } },
            'turn',
        );
        if (!item) throw new Error('expected an item');
        expect(
            settleClaudeToolItem(
                item,
                { tool_use_id: 't1', content: 'ok' },
                { type: 'create' },
                false,
            ),
        ).toMatchObject({ status: 'completed', changes: [{ kind: 'add' }] });
        expect(
            settleClaudeToolItem(
                item,
                { tool_use_id: 't1', content: 'no', is_error: true },
                undefined,
                true,
            ),
        ).toMatchObject({ status: 'declined' });
    });

    it('offers "for this Chat" only when Claude Code suggests a rule to remember', () => {
        expect(
            mapClaudeApproval(
                't1',
                'WebFetch',
                { url: 'https://example.com' },
                { canRemember: false },
            ),
        ).toEqual({
            id: 't1',
            kind: 'tool',
            name: 'WebFetch',
            summary: 'https://example.com',
            decisions: ['accept', 'decline'],
        });
        expect(
            mapClaudeApproval(
                't2',
                'Bash',
                { command: 'rm x', description: 'Remove x' },
                { canRemember: true },
            ),
        ).toEqual({
            id: 't2',
            kind: 'command',
            command: 'rm x',
            reason: 'Remove x',
            decisions: ['accept', 'acceptForSession', 'decline'],
        });
    });

    it('keys question answers by question text', () => {
        const input = {
            questions: [{ question: 'Which?', header: 'H', options: [] }, { question: 'Why?' }],
        };
        expect(claudeQuestionAnswers(input, { q0: ['A', 'B'], q1: [] })).toEqual({
            'Which?': 'A, B',
        });
    });
});
