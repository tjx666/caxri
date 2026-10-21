import { MAX_AGENT_CHAT_DIFF_LENGTH } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    claudeQuestionAnswers,
    mapClaudeApproval,
    mapClaudeQuestion,
    mapClaudeToolUse,
} from '../claude-items';
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

    it('summarizes an unmapped tool by a readable field instead of its raw JSON input', () => {
        const summary = (name: string, input: Record<string, unknown>) => {
            const item = mapClaudeToolUse({ id: 't', name, input }, 'turn');
            return item?.type === 'toolCall' ? item.summary : undefined;
        };
        expect(
            summary('SendMessage', {
                to: 'researcher',
                message: 'Check the parser tests\nThen report back.',
            }),
        ).toBe('to researcher: Check the parser tests');
        expect(summary('SendMessage', { to: 'a9a7d94661c07d', summary: 'Status check' })).toBe(
            'to a9a7d94661c07d: Status check',
        );
        expect(summary('SendMessage', { to: 'lead' })).toBe('to lead');
        expect(summary('TeamCreate', { team_name: 'docs', title: 'Docs team' })).toBe('Docs team');
        expect(summary('Monitor', { pid: 42, verbose: true })).toBe('pid: 42');
        expect(summary('Monitor', { options: { a: 1 } })).toBeUndefined();
        expect(summary('Monitor', {})).toBeUndefined();
        // MCP arguments stay JSON: tracker detection reads a GitHub or Linear call's title and body from them.
        expect(summary('mcp__github__create_issue', { owner: 'o', repo: 'r', title: 'Bug' })).toBe(
            '{"owner":"o","repo":"r","title":"Bug"}',
        );
    });

    it('keeps the JSON arguments of a readably summarized tool for its expanded row', () => {
        expect(
            mapClaudeToolUse(
                { id: 't', name: 'SendMessage', input: { to: 'lead', message: 'Done\nMore' } },
                'turn',
            ),
        ).toMatchObject({
            summary: 'to lead: Done',
            input: String.raw`{"to":"lead","message":"Done\nMore"}`,
        });
        expect(
            mapClaudeToolUse({ id: 't', name: 'Monitor', input: { options: { a: 1 } } }, 'turn'),
        ).toMatchObject({ input: '{"options":{"a":1}}' });
        // A subject field or an MCP call's JSON summary already is the arguments preview.
        expect(
            mapClaudeToolUse(
                { id: 't', name: 'WebFetch', input: { url: 'https://a.test' } },
                'turn',
            ),
        ).not.toHaveProperty('input');
        expect(
            mapClaudeToolUse({ id: 't', name: 'mcp__github__get_me', input: { a: 1 } }, 'turn'),
        ).not.toHaveProperty('input');
    });

    it('names a Claude in Chrome call a browser step titled by what it did', () => {
        const step = (tool: string, input: Record<string, unknown>) =>
            mapClaudeToolUse({ id: 't', name: `mcp__claude-in-chrome__${tool}`, input }, 'turn');
        expect(step('navigate', { url: 'https://example.test/docs', tabId: 7 })).toMatchObject({
            type: 'toolCall',
            name: 'browserUse',
            summary: 'Open https://example.test/docs',
            input: '{"url":"https://example.test/docs","tabId":7}',
        });
        const title = (tool: string, input: Record<string, unknown>) => {
            const item = step(tool, input);
            return item?.type === 'toolCall' ? item.summary : undefined;
        };
        expect(title('navigate', { url: 'back' })).toBe('Go back');
        expect(title('computer', { action: 'left_click', ref: 'ref_12' })).toBe('Click ref_12');
        expect(title('computer', { action: 'double_click', coordinate: [120, 48] })).toBe(
            'Double-click at (120, 48)',
        );
        expect(title('computer', { action: 'type', text: 'hello' })).toBe('Type "hello"');
        expect(title('computer', { action: 'key', text: 'cmd+l' })).toBe('Press cmd+l');
        expect(title('computer', { action: 'screenshot' })).toBe('Take a screenshot');
        expect(title('computer', { action: 'scroll', scroll_direction: 'down' })).toBe(
            'Scroll down',
        );
        expect(title('find', { query: 'Save button' })).toBe('Find Save button');
        expect(title('form_input', { ref: 'ref_3', value: 'Ada' })).toBe('Fill ref_3 with "Ada"');
        expect(title('read_page', { tabId: 1 })).toBe('Read the page');
        expect(title('get_page_text', {})).toBe('Read the page text');
        expect(title('javascript_tool', { action: 'javascript_exec', text: '1' })).toBe(
            'Run JavaScript',
        );
        expect(title('tabs_context_mcp', {})).toBe('Check open tabs');
        expect(title('tabs_create_mcp', {})).toBe('Open a new tab');
        expect(title('resize_window', { width: 800, height: 600 })).toBe(
            'Resize the window to 800x600',
        );
        // A tool this table does not know yet still reads as words, not as its identifier.
        expect(title('read_console_messages', {})).toBe('Read console messages');
        expect(title('some_new_tool_mcp', {})).toBe('Some new tool');
        // Another MCP server keeps the generic MCP row.
        expect(step('navigate', {})).toMatchObject({ name: 'browserUse' });
        expect(
            mapClaudeToolUse({ id: 't', name: 'mcp__other__navigate', input: {} }, 'turn'),
        ).toMatchObject({ name: 'mcp__other__navigate' });
    });

    it('shows an approval the JSON arguments, never a readable digest of them', () => {
        const approval = (name: string, input: Record<string, unknown>) =>
            mapClaudeApproval('t9', name, input, { canRemember: false });
        expect(
            approval('SendMessage', { to: 'lead', message: 'Done\nThen ship it' }),
        ).toMatchObject({
            kind: 'tool',
            summary: String.raw`{"to":"lead","message":"Done\nThen ship it"}`,
        });
        expect(approval('KillShell', { shell_id: 'bash_1' })).toMatchObject({
            summary: '{"shell_id":"bash_1"}',
        });
        expect(approval('WebFetch', { url: 'https://a.test' })).toMatchObject({
            summary: 'https://a.test',
        });
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

    it('carries a multiSelect question through, and only when Claude Code sets it', () => {
        const request = mapClaudeQuestion('t3', {
            questions: [
                { question: 'Which?', header: 'H', options: [], multiSelect: true },
                { question: 'Why?', multiSelect: false },
            ],
        });
        expect(request.questions.map((question) => question.multiSelect)).toEqual([
            true,
            undefined,
        ]);
    });
});
