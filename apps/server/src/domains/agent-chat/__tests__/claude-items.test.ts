import { MAX_AGENT_CHAT_DIFF_LENGTH } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { claudeQuestionAnswers, mapClaudeApproval, mapClaudeToolUse } from '../claude-items';
import { settleClaudeToolItem } from '../claude-tool-results';

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
            mapClaudeToolUse(
                { id: 't6', name: 'ExitPlanMode', input: { plan: '1. Read.\n2. Sum.' } },
                'turn',
            ),
        ).toMatchObject({ type: 'toolCall', summary: '1. Read.\n2. Sum.' });
        expect(
            mapClaudeToolUse({ id: 't4', name: 'TodoWrite', input: {} }, 'turn'),
        ).toBeUndefined();
        expect(
            mapClaudeToolUse({ id: 't5', name: 'AskUserQuestion', input: {} }, 'turn'),
        ).toBeUndefined();
    });

    it('marks a file change truncated when its guessed or real diff was cut, and clears it for a short patch', () => {
        const long = 'x'.repeat(MAX_AGENT_CHAT_DIFF_LENGTH + 10);
        const item = mapClaudeToolUse(
            { id: 't1', name: 'Write', input: { file_path: '/p/a.ts', content: long } },
            'turn',
        );
        if (!item) throw new Error('expected an item');
        expect(item).toMatchObject({ changes: [{ truncated: true }] });
        const patch = (lines: string[]) => [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines },
        ];
        const settle = (lines: string[]) =>
            settleClaudeToolItem(
                item,
                { tool_use_id: 't1', content: 'ok' },
                { structured: { structuredPatch: patch(lines) } },
            );
        expect(settle(['-a', '+b'])).not.toMatchObject({ changes: [{ truncated: true }] });
        expect(settle(['-a', `+${long}`])).toMatchObject({ changes: [{ truncated: true }] });
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
                { structured: { type: 'create' } },
            ),
        ).toMatchObject({ status: 'completed', changes: [{ kind: 'add' }] });
        expect(
            settleClaudeToolItem(
                item,
                { tool_use_id: 't1', content: 'no', is_error: true },
                { wasDeclined: true },
            ),
        ).toMatchObject({ status: 'declined' });
    });

    it('carries a command description, exit code, duration, and background hand-off', () => {
        const command = mapClaudeToolUse(
            {
                id: 'b1',
                name: 'Bash',
                input: { command: 'git status', description: 'Show working tree status' },
            },
            'turn',
        );
        if (!command) throw new Error('expected an item');
        expect(command).toMatchObject({ description: 'Show working tree status' });
        expect(
            settleClaudeToolItem(command, { content: 'clean' }, { durationMs: 1_200 }),
        ).toMatchObject({ status: 'completed', exitCode: 0, durationMs: 1_200 });
        expect(
            settleClaudeToolItem(
                command,
                { content: 'Exit code 128\nfatal: not a git repository', is_error: true },
                { durationMs: 40 },
            ),
        ).toMatchObject({ status: 'failed', exitCode: 128, durationMs: 40 });
        expect(
            settleClaudeToolItem(
                command,
                { content: 'stopped' },
                { structured: { interrupted: true } },
            ),
        ).toMatchObject({ status: 'interrupted' });

        const watcher = mapClaudeToolUse(
            {
                id: 'b2',
                name: 'Bash',
                input: { command: 'bun run watch', run_in_background: true },
            },
            'turn',
        );
        if (!watcher) throw new Error('expected an item');
        expect(watcher).toMatchObject({ background: true });
        const settled = settleClaudeToolItem(
            watcher,
            { content: 'Command running in background with ID: abc' },
            { structured: { backgroundTaskId: 'abc' }, durationMs: 30 },
        );
        expect(settled).toMatchObject({ background: true, status: 'completed' });
        expect(settled).not.toHaveProperty('exitCode');
        expect(settled).not.toHaveProperty('durationMs');
        // A command the user moved to the background mid-run reads the same way.
        expect(
            settleClaudeToolItem(
                command,
                { content: 'moved' },
                { structured: { backgroundedByUser: true } },
            ),
        ).toMatchObject({ background: true });
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
