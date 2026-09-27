import { Buffer } from 'node:buffer';
import { appendFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalRecord } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CaxriDatabase } from '../../db';
import { appendClaudeTimelineRecord } from '../providers/claude/timeline';
import { appendCodexTimelineRecord } from '../providers/codex/timeline';
import { readAgentReplySummary } from '../reply-summary';
import { AgentTimelineService } from '../timeline';
import { TimelineBuilder } from '../timeline-model';

/**
 * Sanitized native record shape established by the adjacent Claude provider tests and Codex rollout writer/types. No
 * host Agent transcript is read or copied into this public-ready fixture.
 *
 * @see https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs
 * @see https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs
 */
const claude = (type: 'user' | 'assistant', uuid: string, content: unknown, extra = {}) => ({
    type,
    uuid,
    timestamp: '2026-01-02T03:04:05.000Z',
    message: { content },
    ...extra,
});

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

describe('AgentTimelineService', () => {
    let home: string;
    let cwd: string;
    let transcript: string;
    let terminal: Partial<TerminalRecord>;
    let service: AgentTimelineService;

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'caxri-timeline-'));
        cwd = join(home, 'project');
        const root = join(home, '.claude', 'projects', cwd.replaceAll(/[^a-z0-9]/gi, '-'));
        await mkdir(root, { recursive: true });
        transcript = join(root, 'fixture-session.jsonl');
        terminal = {
            id: 'terminal-fixture',
            sessionId: 'session-fixture',
            provider: 'claude',
            agentSessionId: 'fixture-session',
            cwd,
        };
        const database = { getTerminal: () => terminal } as unknown as CaxriDatabase;
        service = new AgentTimelineService(database, { homeDirectory: home, variables: {} });
    });

    afterEach(async () => {
        await rm(home, { force: true, recursive: true });
    });

    function line(index: number, text = `Message ${index}`): string {
        return `${JSON.stringify(claude('user', `fixture-${index}`, [{ type: 'text', text }]))}\n`;
    }

    it('reads appended records once, preserves IDs, and pages older entries', async () => {
        await writeFile(transcript, [line(1), line(2), line(3)].join(''));
        const first = await service.read('session-fixture', 'terminal-fixture', undefined, 2);
        expect(first.items.map((item) => item.type)).toEqual(['userMessage', 'userMessage']);
        expect(first.olderCursor).toBeDefined();
        const older = await service.read(
            'session-fixture',
            'terminal-fixture',
            first.olderCursor,
            2,
        );
        expect(older.items).toHaveLength(1);
        expect(older.items[0]).toMatchObject({ text: 'Message 1' });
        await appendFile(transcript, line(4));
        const second = await service.read('session-fixture', 'terminal-fixture', undefined, 2);
        expect(second.items.at(-1)).toMatchObject({ text: 'Message 4' });
        expect(second.items[0]?.id).toBe(first.items.at(-1)?.id);
    });

    it('summarizes the closing reply of a real Claude transcript for the system notification', async () => {
        await writeFile(
            transcript,
            [
                claude('user', 'fixture-user', [{ type: 'text', text: 'Fix the test' }]),
                claude('assistant', 'fixture-reply', [
                    { type: 'text', text: '**Fixed** the flaky test.\n\nPushed the branch.' },
                ]),
            ]
                .map((record) => `${JSON.stringify(record)}\n`)
                .join(''),
        );
        const database = {
            getSession: () => ({ primaryAgentTerminalId: 'terminal-fixture' }),
            getTerminal: () => terminal,
        } as unknown as CaxriDatabase;
        const timeline = new AgentTimelineService(database, { homeDirectory: home, variables: {} });
        await expect(readAgentReplySummary(database, timeline, 'session-fixture')).resolves.toEqual(
            {
                summary: 'Fixed the flaky test. Pushed the branch.',
            },
        );
        terminal.provider = 'grok';
        timeline.forgetTerminal('terminal-fixture');
        await expect(readAgentReplySummary(database, timeline, 'session-fixture')).resolves.toEqual(
            {},
        );
    });

    it('reports unsupported for a provider without a timeline projector', async () => {
        await writeFile(transcript, line(1));
        terminal.provider = 'grok';
        const result = await service.read('session-fixture', 'terminal-fixture', undefined, 2);
        expect(result).toEqual({
            status: 'unsupported',
            items: [],
            truncated: false,
            cursorExpired: false,
        });
    });

    it('keeps concurrent append reads and their cursors coherent', async () => {
        await writeFile(transcript, line(1) + line(2));
        await service.read('session-fixture', 'terminal-fixture', undefined, 100);
        await appendFile(
            transcript,
            `${JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 100 })}\n`,
        );
        const pages = await Promise.all(
            Array.from({ length: 8 }, () =>
                service.read('session-fixture', 'terminal-fixture', undefined, 100),
            ),
        );
        for (const page of pages) {
            expect(page.items).toHaveLength(3);
            expect(new Set(page.items.map((item) => item.id)).size).toBe(3);
        }
        const latest = await service.read('session-fixture', 'terminal-fixture', undefined, 1);
        const older = await service.read(
            'session-fixture',
            'terminal-fixture',
            latest.olderCursor,
            100,
        );
        expect(older.cursorExpired).toBe(false);
        expect(older.items).toHaveLength(2);
    });

    it('discards reads queued before a Terminal is forgotten', async () => {
        await writeFile(transcript, line(1));
        const pending = service.read('session-fixture', 'terminal-fixture', undefined, 100);
        service.forgetTerminal('terminal-fixture');
        expect(await pending).toMatchObject({ status: 'missing', items: [] });
        expect(
            await service.read('session-fixture', 'terminal-fixture', undefined, 100),
        ).toMatchObject({ status: 'available', items: [{ text: 'Message 1' }] });
    });

    it('expires a cursor after a same-size file replacement', async () => {
        await writeFile(transcript, line(1, 'Old text') + line(2, 'Old text'));
        const first = await service.read('session-fixture', 'terminal-fixture', undefined, 1);
        expect(first.olderCursor).toBeDefined();
        const replacement = join(home, 'replacement.jsonl');
        await writeFile(replacement, line(3, 'New text') + line(4, 'New text'));
        await rename(replacement, transcript);
        const second = await service.read(
            'session-fixture',
            'terminal-fixture',
            first.olderCursor,
            1,
        );
        expect(second.cursorExpired).toBe(true);
        expect(second.items[0]).toMatchObject({ text: 'New text' });
        expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    });

    it('rebuilds a same-size in-place rewrite and drops a truncated oversized first record', async () => {
        await writeFile(transcript, line(1, 'Old text') + line(2, 'Old text'));
        const first = await service.read('session-fixture', 'terminal-fixture', undefined, 1);
        await writeFile(transcript, line(3, 'New text') + line(4, 'New text'));
        const future = new Date(Date.now() + 5_000);
        await utimes(transcript, future, future);
        const replacement = await service.read(
            'session-fixture',
            'terminal-fixture',
            first.olderCursor,
            1,
        );
        expect(replacement.cursorExpired).toBe(true);
        expect(replacement.items[0]).toMatchObject({ text: 'New text' });

        await writeFile(transcript, `${'x'.repeat(4 * 1024 * 1024 + 1)}\n${line(5)}`);
        const tail = await service.read('session-fixture', 'terminal-fixture', undefined, 1);
        expect(tail.items).toHaveLength(1);
        expect(tail.items[0]).toMatchObject({ text: 'Message 5' });
        expect(tail.truncated).toBe(true);
    });

    it('paginates two entries from one JSONL record without skipping the older sibling', async () => {
        await writeFile(
            transcript,
            `${JSON.stringify(
                claude('assistant', 'mixed', [
                    { type: 'text', text: 'I will check.' },
                    {
                        type: 'tool_use',
                        id: 'call-mixed',
                        name: 'Bash',
                        input: { command: 'printf ready' },
                    },
                ]),
            )}\n`,
        );
        const latest = await service.read('session-fixture', 'terminal-fixture', undefined, 1);
        expect(latest.items).toHaveLength(1);
        expect(latest.items[0]?.type).toBe('toolCall');
        expect(latest.olderCursor).toBeDefined();
        const older = await service.read(
            'session-fixture',
            'terminal-fixture',
            latest.olderCursor,
            1,
        );
        expect(older.items).toHaveLength(1);
        expect(older.items[0]).toMatchObject({ type: 'agentMessage', text: 'I will check.' });
        expect(older.items[0]?.id).not.toBe(latest.items[0]?.id);

        // Move the cursor record outside the cached tail before replaying the same older-page request.
        await appendFile(transcript, `${'x'.repeat(4 * 1024 * 1024 + 1)}\n${line(9)}`);
        await service.read('session-fixture', 'terminal-fixture', undefined, 1);
        const uncachedOlder = await service.read(
            'session-fixture',
            'terminal-fixture',
            latest.olderCursor,
            1,
        );
        expect(uncachedOlder.items).toEqual(older.items);
    });

    it('does not put malformed transcript content in diagnostics', async () => {
        const marker = 'PRIVATE_FIXTURE_TRANSCRIPT_BODY';
        const logged = [
            vi.spyOn(console, 'error').mockImplementation(() => {}),
            vi.spyOn(console, 'warn').mockImplementation(() => {}),
            vi.spyOn(console, 'log').mockImplementation(() => {}),
        ];
        try {
            await writeFile(transcript, `{not-json:${marker}}\n${line(1)}`);
            const result = await service.read('session-fixture', 'terminal-fixture', undefined, 40);
            expect(result.items).toHaveLength(1);
            expect(JSON.stringify(logged.flatMap((spy) => spy.mock.calls))).not.toContain(marker);
        } finally {
            for (const spy of logged) spy.mockRestore();
        }
    });

    it('keeps even a full 80-item page beneath the encrypted frame budget', async () => {
        await writeFile(
            transcript,
            Array.from({ length: 80 }, (_, index) => line(index, '中'.repeat(4_096))).join(''),
        );
        const page = await service.read('session-fixture', 'terminal-fixture', undefined, 80);
        expect(page.items.length).toBeGreaterThan(0);
        expect(page.items.length).toBeLessThan(80);
        expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThan(48 * 1_024);
        expect(page.olderCursor).toBeDefined();
        const older = await service.read(
            'session-fixture',
            'terminal-fixture',
            page.olderCursor,
            80,
        );
        expect(older.items.length).toBeGreaterThan(0);
        expect(older.items.at(-1)?.id).not.toBe(page.items[0]?.id);
    });

    it('continues older pages past the retained 16 MiB cache window', async () => {
        const padding = 'x'.repeat(128 * 1_024);
        await writeFile(
            transcript,
            Array.from(
                { length: 170 },
                (_, index) =>
                    `${JSON.stringify({
                        ...claude('user', `fixture-${index}`, [
                            { type: 'text', text: `Message ${index}` },
                        ]),
                        padding,
                    })}\n`,
            ).join(''),
        );
        let before: string | undefined;
        const seen = new Set<string>();
        let isReachedFirst = false;
        for (let pageNumber = 0; pageNumber < 8; pageNumber++) {
            // eslint-disable-next-line no-await-in-loop -- each cursor depends on the prior bounded page
            const page = await service.read('session-fixture', 'terminal-fixture', before, 80);
            expect(page.cursorExpired).toBe(false);
            expect(page.items.length).toBeGreaterThan(0);
            for (const item of page.items) {
                expect(seen.has(item.id)).toBe(false);
                seen.add(item.id);
                if (item.type === 'userMessage' && item.text === 'Message 0') isReachedFirst = true;
            }
            if (isReachedFirst) break;
            before = page.olderCursor;
            expect(before).toBeDefined();
        }
        expect(isReachedFirst).toBe(true);
    });
});
