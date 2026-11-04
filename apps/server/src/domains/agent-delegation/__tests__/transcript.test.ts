import type { AgentChatItem, AgentDelegationTranscript } from '@caxri/protocol';
import {
    MAX_DELEGATION_TRANSCRIPT_PAGE_TEXT,
    MAX_DELEGATION_TRANSCRIPT_PATHS,
    MAX_DELEGATION_TRANSCRIPT_ROW_TEXT,
    MAX_DELEGATION_TRANSCRIPT_ROWS,
} from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { StoredAgentDelegation } from '../../db';
import type { DelegationTranscriptSnapshot, DelegationTranscriptSource } from '../transcript';
import { readDelegationChatPage } from '../transcript';

function record(
    status: 'running' | 'completed' = 'running',
    terminalId: string | null = 'terminal-1',
    delegationId = 'task-1',
): StoredAgentDelegation {
    return {
        receipt: {
            delegationId,
            projectId: 'project-1',
            sessionId: 'session-1',
            provider: 'claude',
            status,
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
            ...(terminalId && { terminalId }),
        },
        principal: { kind: 'human-cli', id: 'synthetic-owner' },
        input: {
            projectId: 'project-1',
            sessionId: 'session-1',
            provider: 'claude',
            prompt: 'Synthetic task',
        },
        fingerprint: 'synthetic-fingerprint',
        promptDigest: 'a'.repeat(64),
        frozenLaunch: { executable: 'claude', args: [] },
    } satisfies StoredAgentDelegation;
}

const pointer = (id: string, delegationId: string): AgentChatItem => ({
    id,
    type: 'userMessage',
    text: 'Read the task in a private file.',
    delegatedTask: { delegationId },
});
const human = (id: string): AgentChatItem => ({
    id,
    type: 'userMessage',
    text: 'Typed by the user',
});
const reply = (id: string, text: string, isStreaming = false): AgentChatItem => ({
    id,
    type: 'agentMessage',
    text,
    streaming: isStreaming,
});

function source(
    snapshot: DelegationTranscriptSnapshot | undefined,
    overrides: Partial<DelegationTranscriptSource> = {},
): DelegationTranscriptSource & { write: ReturnType<typeof vi.fn> } {
    const write = vi.fn();
    return {
        readChildChat: () => true,
        isChatTerminal: () => true,
        snapshot: () => snapshot,
        logger: { write } as unknown as DelegationTranscriptSource['logger'],
        write,
        ...overrides,
    };
}

function available(result: AgentDelegationTranscript) {
    if (result.status !== 'available') throw new Error(`unavailable: ${result.reason}`);
    return result;
}

describe('readDelegationChatPage', () => {
    it.each([
        ['disabled', source({ items: [] }, { readChildChat: () => false }), record()],
        ['not_started', source({ items: [] }), record('running', null)],
        ['not_chat', source({ items: [] }, { isChatTerminal: () => false }), record()],
        ['projection_lost', source(undefined), record()],
        ['boundary_unproven', source({ items: [reply('a', 'Earlier work')] }), record()],
    ] as const)('answers %s without reading rows', (reason, chat, task) => {
        expect(readDelegationChatPage(chat, task, undefined)).toEqual({
            status: 'unavailable',
            reason,
        });
    });

    it('returns only the task conversation, from its pointer up to the next message anyone sent', () => {
        const chat = source({
            historyId: 'history-1',
            items: [
                human('before'),
                reply('earlier', 'Work from before the task'),
                pointer('start', 'task-1'),
                reply('mine', 'Done with the task'),
                {
                    id: 'edit',
                    type: 'fileChange',
                    status: 'completed',
                    changes: [{ path: 'src/a.ts', kind: 'update', diff: '+secret diff' }],
                },
                human('takeover'),
                reply('after', 'Answer to the user'),
                pointer('next', 'task-2'),
            ],
        });
        const result = available(readDelegationChatPage(chat, record('completed'), undefined));
        expect(result.rows).toEqual([
            { id: 'start', kind: 'task' },
            { id: 'mine', kind: 'agentMessage', text: 'Done with the task' },
            {
                id: 'edit',
                kind: 'fileChange',
                status: 'completed',
                paths: [{ path: 'src/a.ts', change: 'update' }],
            },
        ]);
        expect(result.settled).toBe(true);
        expect(result.hasMore).toBe(false);
    });

    it('ends at a later task pointer too', () => {
        const chat = source({
            items: [pointer('start', 'task-1'), reply('mine', 'One'), pointer('next', 'task-2')],
        });
        const result = available(readDelegationChatPage(chat, record(), undefined));
        expect(result.rows).toHaveLength(2);
    });

    it('resumes after the cursor and never resumes past a message still being written', () => {
        const items: AgentChatItem[] = [pointer('start', 'task-1'), reply('one', 'First')];
        const chat = source({ historyId: 'history-1', items });
        const first = available(readDelegationChatPage(chat, record(), undefined));
        expect(first.next).toBeDefined();

        items.push(reply('two', 'Writ', true));
        const second = available(readDelegationChatPage(chat, record(), first.next));
        expect(second.rows).toEqual([
            { id: 'two', kind: 'agentMessage', text: 'Writ', streaming: true },
        ]);
        expect(second.settled).toBe(false);

        items[2] = reply('two', 'Written');
        const third = available(readDelegationChatPage(chat, record(), second.next));
        expect(third.rows).toEqual([{ id: 'two', kind: 'agentMessage', text: 'Written' }]);
    });

    it('returns a running step and every row after it again until the step finishes', () => {
        const running: AgentChatItem = {
            id: 'run',
            type: 'command',
            command: 'pnpm test',
            status: 'running',
            output: '',
        };
        const items: AgentChatItem[] = [
            pointer('start', 'task-1'),
            reply('one', 'First'),
            running,
            reply('three', 'Meanwhile'),
        ];
        const chat = source({ historyId: 'history-1', items });
        const first = available(readDelegationChatPage(chat, record(), undefined));
        expect(first.rows.map((row) => row.id)).toEqual(['start', 'one', 'run', 'three']);
        expect(first.hasMore).toBe(false);

        const again = available(readDelegationChatPage(chat, record(), first.next));
        expect(again.rows.map((row) => row.id)).toEqual(['run', 'three']);
        expect(again.next).toBe(first.next);

        items[2] = { ...running, status: 'completed', output: 'passed', exitCode: 0 };
        const settled = available(readDelegationChatPage(chat, record(), again.next));
        expect(settled.rows[0]).toMatchObject({ id: 'run', status: 'completed', exitCode: 0 });
        const done = available(readDelegationChatPage(chat, record(), settled.next));
        expect(done.rows).toEqual([]);
        expect(done.next).toBe(settled.next);
    });

    it('does not report more rows while a streaming row holds the page open', () => {
        const many = Array.from({ length: MAX_DELEGATION_TRANSCRIPT_ROWS + 5 }, (_, index) =>
            reply(`r${index}`, 'x', index === 3),
        );
        const chat = source({ items: [pointer('start', 'task-1'), ...many] });
        const first = available(readDelegationChatPage(chat, record(), undefined));
        expect(first.rows).toHaveLength(MAX_DELEGATION_TRANSCRIPT_ROWS);
        expect(first.hasMore).toBe(false);
        const reread = available(readDelegationChatPage(chat, record(), first.next));
        expect(reread.rows[0]).toMatchObject({ id: 'r3', streaming: true });
        /**
         * A full page that starts at the open row moves on rather than returning itself forever.
         */
        expect(reread.hasMore).toBe(true);
        const tail = available(readDelegationChatPage(chat, record(), reread.next));
        expect(tail.rows.at(-1)).toMatchObject({ id: `r${MAX_DELEGATION_TRANSCRIPT_ROWS + 4}` });
    });

    it('reaches every row of a settled task past a background command still running', () => {
        const background: AgentChatItem = {
            id: 'server',
            type: 'command',
            command: 'pnpm dev',
            status: 'running',
            output: '',
        };
        const later = Array.from({ length: MAX_DELEGATION_TRANSCRIPT_ROWS + 5 }, (_, index) =>
            reply(`r${index}`, 'x'),
        );
        const chat = source({ items: [pointer('start', 'task-1'), background, ...later] });
        const ids: string[] = [];
        let after: string | undefined;
        for (let read = 0; read < 5; read++) {
            const result = available(readDelegationChatPage(chat, record('completed'), after));
            ids.push(...result.rows.map((row) => row.id));
            after = result.next;
            if (!result.hasMore) break;
        }
        expect(ids).toHaveLength(later.length + 2);
        expect(ids.at(-1)).toBe(`r${later.length - 1}`);
    });

    it('streams reasoning like a message', () => {
        const chat = source({
            items: [
                pointer('start', 'task-1'),
                { id: 'think', type: 'reasoning', text: 'Hmm', streaming: true },
            ],
        });
        const result = available(readDelegationChatPage(chat, record(), undefined));
        expect(result.rows[1]).toEqual({
            id: 'think',
            kind: 'reasoning',
            text: 'Hmm',
            streaming: true,
        });
        expect(result.next).toBeDefined();
    });

    it('keeps the cursor short whatever the row id holds', () => {
        const id = '😀'.repeat(100);
        const chat = source({
            historyId: 'history-1',
            items: [pointer('start', 'task-1'), reply(id, 'One'), reply('two', 'Two')],
        });
        const short = source({
            historyId: 'history-1',
            items: [pointer('start', 'task-1'), reply(id, 'One')],
        });
        const head = available(readDelegationChatPage(short, record(), undefined));
        expect(head.next!.length).toBeLessThan(40);
        const tail = available(readDelegationChatPage(chat, record(), head.next));
        expect(tail.rows.map((row) => row.id)).toEqual(['two']);
    });

    it('rejects a cursor from another task or an earlier history', () => {
        const items = [pointer('start', 'task-1'), reply('one', 'First')];
        const first = available(
            readDelegationChatPage(source({ historyId: 'history-1', items }), record(), undefined),
        );
        const otherTask = source({
            historyId: 'history-1',
            items: [pointer('s', 'task-2'), ...items.slice(1)],
        });
        for (const [chat, task, after] of [
            [source({ historyId: 'history-2', items }), record(), first.next],
            [otherTask, record('running', 'terminal-1', 'task-2'), first.next],
            [source({ historyId: 'history-1', items }), record(), 'not-a-cursor'],
            [source({ historyId: 'history-1', items }), record(), `1.9.${'a'.repeat(22)}`],
        ] as const)
            expect(readDelegationChatPage(chat, task, after)).toEqual({
                status: 'unavailable',
                reason: 'cursor_invalid',
            });
    });

    it('pages by row count and text length, always returning at least one row', () => {
        const many = Array.from({ length: MAX_DELEGATION_TRANSCRIPT_ROWS + 5 }, (_, index) =>
            reply(`r${index}`, 'x'),
        );
        const chat = source({ items: [pointer('start', 'task-1'), ...many] });
        const first = available(readDelegationChatPage(chat, record(), undefined));
        expect(first.rows).toHaveLength(MAX_DELEGATION_TRANSCRIPT_ROWS);
        expect(first.hasMore).toBe(true);
        const rest = available(readDelegationChatPage(chat, record(), first.next));
        expect(rest.rows).toHaveLength(6);
        expect(rest.hasMore).toBe(false);

        const long = 'y'.repeat(MAX_DELEGATION_TRANSCRIPT_ROW_TEXT * 2);
        const heavy = Array.from(
            {
                length:
                    MAX_DELEGATION_TRANSCRIPT_PAGE_TEXT / MAX_DELEGATION_TRANSCRIPT_ROW_TEXT + 2,
            },
            (_, index) => reply(`h${index}`, long),
        );
        const heavyChat = source({ items: [pointer('start', 'task-1'), ...heavy] });
        const page = available(readDelegationChatPage(heavyChat, record(), undefined));
        expect(page.rows.length).toBeLessThan(heavy.length + 1);
        expect(page.hasMore).toBe(true);
        expect(page.rows[1]).toMatchObject({ truncated: true });
        expect(page.rows[1]).toHaveProperty(
            'text',
            long.slice(0, MAX_DELEGATION_TRANSCRIPT_ROW_TEXT),
        );
    });

    it('keeps the tail of command output and caps listed paths', () => {
        const output = `${'z'.repeat(MAX_DELEGATION_TRANSCRIPT_ROW_TEXT)}exit summary`;
        const chat = source({
            items: [
                pointer('start', 'task-1'),
                {
                    id: 'c',
                    type: 'command',
                    command: 'pnpm test',
                    status: 'failed',
                    output,
                    exitCode: 1,
                },
                {
                    id: 'f',
                    type: 'fileChange',
                    status: 'completed',
                    changes: Array.from(
                        { length: MAX_DELEGATION_TRANSCRIPT_PATHS + 1 },
                        (_, index) => ({
                            path: `file-${index}.ts`,
                            kind: 'add' as const,
                            diff: '',
                        }),
                    ),
                },
            ],
        });
        const [, command, files] = available(
            readDelegationChatPage(chat, record(), undefined),
        ).rows;
        expect(command).toMatchObject({ kind: 'command', exitCode: 1, truncated: true });
        expect(command).toHaveProperty('output', expect.stringMatching(/exit summary$/u));
        expect(files).toMatchObject({ truncated: true });
        expect((files as { paths: unknown[] }).paths).toHaveLength(MAX_DELEGATION_TRANSCRIPT_PATHS);
    });

    it('logs counts and enums only, never row text or the cursor', () => {
        const chat = source({
            items: [pointer('start', 'task-1'), reply('one', 'Private reply text')],
        });
        readDelegationChatPage(chat, record(), undefined);
        const logged = JSON.stringify(chat.write.mock.calls);
        expect(chat.write).toHaveBeenCalledWith('info', 'agent_delegation.transcript_read', {
            fields: {
                provider: 'claude',
                outcome: 'available',
                reason: null,
                isResumed: false,
                rowCount: 2,
                textLength: 'Private reply text'.length,
                isTruncated: false,
                hasMore: false,
                durationMs: expect.any(Number) as number,
            },
        });
        expect(logged).not.toContain('Private reply text');
        expect(logged).not.toContain('"one"');
        expect(logged).not.toContain('task-1');
    });
});
