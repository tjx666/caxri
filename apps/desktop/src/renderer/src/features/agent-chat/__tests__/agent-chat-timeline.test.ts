import type { AgentChatItem, AgentChatTurn } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { AgentChatTimelineEntry } from '../agent-chat-timeline';
import {
    agentChatOutputLanguage,
    agentChatReasoningTitle,
    agentChatTurnLabel,
    agentChatTurnTone,
    agentChatWorkDuration,
    agentChatWorkGroupFailure,
    buildAgentChatTimeline,
    describeAgentChatWork,
    splitAgentChatWork,
    stripLineNumberGutter,
    summarizeAgentChatWork,
} from '../agent-chat-timeline';

const user = (id: string, turnId?: string): AgentChatItem => ({
    id,
    ...(turnId && { turnId }),
    type: 'userMessage',
    text: 'hi',
});
const reply = (id: string, turnId?: string): AgentChatItem => ({
    id,
    ...(turnId && { turnId }),
    type: 'agentMessage',
    text: 'done',
    streaming: false,
});
const command = (id: string, turnId?: string, text = 'git status'): AgentChatItem => ({
    id,
    ...(turnId && { turnId }),
    type: 'command',
    command: text,
    status: 'completed',
    output: '',
});
const read = (id: string, turnId?: string): AgentChatItem => ({
    id,
    ...(turnId && { turnId }),
    type: 'toolCall',
    name: 'Read',
    summary: '/work/src/app.ts',
    status: 'completed',
});
const thought = (id: string, turnId?: string): AgentChatItem => ({
    id,
    ...(turnId && { turnId }),
    type: 'reasoning',
    text: 'thinking',
    streaming: false,
});

const shape = (entries: readonly AgentChatTimelineEntry[]): unknown =>
    entries.map((entry) =>
        entry.kind === 'item'
            ? entry.item.id
            : entry.kind === 'work'
              ? entry.items.map((item) => item.id)
              : { [entry.label]: shape(entry.entries) },
    );

describe('buildAgentChatTimeline', () => {
    it('groups consecutive work between messages while a turn runs', () => {
        const turns: AgentChatTurn[] = [{ id: 't1', status: 'running' }];
        const items = [
            user('u', 't1'),
            thought('r1', 't1'),
            command('c1', 't1'),
            read('x1', 't1'),
            reply('a1', 't1'),
            command('c2', 't1'),
        ];
        expect(shape(buildAgentChatTimeline(items, turns, 't1'))).toEqual([
            'u',
            ['r1', 'c1', 'x1'],
            'a1',
            ['c2'],
        ]);
    });

    it('folds a finished turn behind its duration, keeping the prompt, final reply, and notices', () => {
        const turns: AgentChatTurn[] = [{ id: 't1', status: 'completed', durationMs: 121_000 }];
        const items: AgentChatItem[] = [
            user('u', 't1'),
            command('c1', 't1'),
            reply('a1', 't1'),
            command('c2', 't1'),
            { id: 'e', turnId: 't1', type: 'notice', kind: 'error', message: 'boom' },
            { id: 'r', turnId: 't1', type: 'notice', kind: 'retrying' },
            reply('a2', 't1'),
        ];
        expect(shape(buildAgentChatTimeline(items, turns, undefined))).toEqual([
            'u',
            { 'Worked for 2m 1s': [['c1'], 'a1', ['c2'], 'r'] },
            'e',
            'a2',
        ]);
    });

    it('leaves a finished turn with nothing to fold, and items without a turn, as they are', () => {
        const turns: AgentChatTurn[] = [{ id: 't1', status: 'completed' }];
        const items = [user('u', 't1'), reply('a1', 't1'), command('c', undefined)];
        expect(shape(buildAgentChatTimeline(items, turns, undefined))).toEqual(['u', 'a1', ['c']]);
    });

    it('marks only the reply that ends a turn, and none while the turn runs', () => {
        const finalReplies = (entries: readonly AgentChatTimelineEntry[]): string[] =>
            entries.flatMap((entry) =>
                entry.kind === 'item'
                    ? entry.isFinalReply
                        ? [entry.item.id]
                        : []
                    : entry.kind === 'turn'
                      ? finalReplies(entry.entries)
                      : [],
            );
        const items = [
            user('u1', 't1'),
            reply('a1', 't1'),
            command('c1', 't1'),
            reply('a2', 't1'),
            user('u2', 't2'),
            reply('a3', 't2'),
            command('c2', 't2'),
            reply('a4', 't2'),
            command('c3', 't2'),
        ];
        const turns: AgentChatTurn[] = [
            { id: 't1', status: 'completed', durationMs: 1000 },
            { id: 't2', status: 'running' },
        ];
        expect(finalReplies(buildAgentChatTimeline(items, turns, 't2'))).toEqual(['a2']);
        const ended = buildAgentChatTimeline(
            items,
            [turns[0], { id: 't2', status: 'completed', durationMs: 1000 }],
            undefined,
        );
        expect(finalReplies(ended)).toEqual(['a2', 'a4']);
        // A subagent transcript has no turn records; each run of its items still ends on one reply.
        const subagent = buildAgentChatTimeline(
            [reply('s1'), command('sc'), reply('s2')],
            [],
            undefined,
        );
        expect(finalReplies(subagent)).toEqual(['s2']);
    });

    it('skips empty reasoning', () => {
        const items: AgentChatItem[] = [
            { id: 'r', type: 'reasoning', text: '', streaming: true },
            command('c'),
        ];
        expect(shape(buildAgentChatTimeline(items, [], undefined))).toEqual([['c']]);
    });
});

describe('agentChatTurnLabel', () => {
    it('names how the turn ended', () => {
        expect(agentChatTurnLabel({ id: 't', status: 'completed', durationMs: 45_000 })).toBe(
            'Worked for 45s',
        );
        expect(agentChatTurnLabel({ id: 't', status: 'interrupted', durationMs: 3000 })).toBe(
            'Stopped after 3s',
        );
        expect(agentChatTurnLabel({ id: 't', status: 'failed' })).toBe('Failed');
    });
});

describe('agentChatTurnTone', () => {
    it('tones a failed or stopped turn and keeps a completed one quiet', () => {
        expect(agentChatTurnTone('failed')).toBe('danger');
        expect(agentChatTurnTone('interrupted')).toBe('warning');
        expect(agentChatTurnTone('completed')).toBeUndefined();
    });
});

describe('describeAgentChatWork', () => {
    it('shows the inner command of a login-shell wrapper', () => {
        expect(
            describeAgentChatWork({
                id: 'c',
                type: 'command',
                command: `/bin/zsh -lc "git log --format='%h %s' -5"`,
                status: 'completed',
                output: '',
            }),
        ).toEqual({
            kind: 'command',
            label: 'Ran',
            subject: "git log --format='%h %s' -5",
            isCodeSubject: true,
        });
    });

    it('names the file a shell read printed, even when the Agent described the command', () => {
        expect(
            describeAgentChatWork({
                id: 'c',
                type: 'command',
                command: `/bin/zsh -lc "sed -n '1,40p' docs/SKILL.md"`,
                description: 'Read the skill',
                status: 'completed',
                output: '',
            }),
        ).toEqual({
            kind: 'read',
            label: 'Read',
            subject: 'SKILL.md',
            isCodeSubject: true,
            path: 'docs/SKILL.md',
        });
    });

    it("titles a command with the Agent's description when it wrote one", () => {
        expect(
            describeAgentChatWork({
                id: 'c',
                type: 'command',
                command: 'git status --short',
                description: 'Show working tree status',
                status: 'completed',
                output: '',
            }),
        ).toEqual({
            kind: 'command',
            label: 'Ran',
            subject: 'Show working tree status',
            isCodeSubject: false,
        });
    });

    it('names the first changed file and how many more', () => {
        expect(
            describeAgentChatWork({
                id: 'f',
                type: 'fileChange',
                status: 'completed',
                changes: [
                    { path: 'src/a.ts', kind: 'update', diff: '' },
                    { path: 'src/b.ts', kind: 'add', diff: '' },
                ],
            }),
        ).toMatchObject({ kind: 'edit', label: 'Edited', subject: 'a.ts +1 more' });
    });

    it('names a failed, declined, or stopped item in its verb', () => {
        const change = (status: 'declined' | 'failed' | 'running') =>
            describeAgentChatWork({
                id: 'f',
                type: 'fileChange',
                status,
                changes: [{ path: 'src/a.ts', kind: 'update', diff: '' }],
            });
        expect(change('failed').label).toBe('Failed to edit');
        expect(change('declined').label).toBe('Not allowed to edit');
        expect(
            describeAgentChatWork({
                id: 'c',
                type: 'command',
                command: 'npm test',
                status: 'interrupted',
                output: '',
            }).label,
        ).toBe('Stopped running');
        expect(change('running').label).toBe('Edited');
    });
});

describe('agentChatWorkDuration', () => {
    it('always times a command and times other tools once it is noticeable', () => {
        const command = {
            id: 'c',
            type: 'command',
            command: 'ls',
            status: 'completed',
            output: '',
        } as const;
        expect(agentChatWorkDuration({ ...command, durationMs: 300 })).toBe('<1s');
        expect(agentChatWorkDuration(command)).toBeNull();
        const tool = { id: 't', type: 'toolCall', name: 'webSearch', status: 'completed' } as const;
        expect(agentChatWorkDuration({ ...tool, durationMs: 300 })).toBeNull();
        expect(agentChatWorkDuration({ ...tool, durationMs: 2_000 })).toBe('2s');
    });
});

describe('summarizeAgentChatWork', () => {
    it('counts tools by kind and only names reasoning when it is alone', () => {
        const items = [thought('r'), command('c1'), command('c2'), read('x')] as Parameters<
            typeof summarizeAgentChatWork
        >[0];
        expect(summarizeAgentChatWork(items)).toBe('Ran 2 commands, read 1 file');
        expect(
            summarizeAgentChatWork([thought('r')] as Parameters<typeof summarizeAgentChatWork>[0]),
        ).toBe('Thought');
    });

    it('counts failed and declined items at the end', () => {
        const items = [
            command('c1'),
            { ...command('c2'), status: 'failed' },
            { ...read('x'), status: 'declined' },
        ] as Parameters<typeof summarizeAgentChatWork>[0];
        expect(summarizeAgentChatWork(items)).toBe('Ran 2 commands, read 1 file, 2 failed');
    });
});

describe('agentChatWorkGroupFailure', () => {
    type Items = Parameters<typeof agentChatWorkGroupFailure>[0];

    it('prefers failed over declined and is absent for a clean run', () => {
        expect(agentChatWorkGroupFailure([command('c1'), read('x')] as Items)).toBeUndefined();
        expect(
            agentChatWorkGroupFailure([
                command('c1'),
                { ...read('x'), status: 'declined' },
            ] as Items),
        ).toBe('declined');
        expect(
            agentChatWorkGroupFailure([
                { ...read('x'), status: 'declined' },
                { ...command('c1'), status: 'failed' },
            ] as Items),
        ).toBe('failed');
    });
});

describe('agentChatOutputLanguage', () => {
    const run = (text: string, output = 'x') =>
        agentChatOutputLanguage({
            id: 'c',
            type: 'command',
            command: text,
            status: 'completed',
            output,
        });

    it('infers the language of a printed file, a Git diff, JSON, or else the shell', () => {
        expect(run(`/bin/zsh -lc "sed -n '1,420p' /work/skills/SKILL.md"`)).toBe('md');
        expect(run('cat src/app.ts')).toBe('ts');
        expect(run('git -C repo diff HEAD~1')).toBe('diff');
        expect(run('git show --stat HEAD')).toBe('shell');
        expect(run('agent-browser skills get core --full | sed -n 1,700p')).toBe('shell');
        expect(run('gh api repos/a/b', '{"ok": true}')).toBe('json');
        // Any other command output is painted as the shell it came from.
        expect(run('ls -la', 'total 0')).toBe('shell');
    });

    it('uses the path a file tool read', () => {
        expect(
            agentChatOutputLanguage({
                id: 't',
                type: 'toolCall',
                name: 'Read',
                summary: '/work/src/main.py',
                status: 'completed',
                output: 'print(1)',
            }),
        ).toBe('py');
    });
});

describe('stripLineNumberGutter', () => {
    it("drops Claude Code's Read line numbers only when every line has one", () => {
        expect(stripLineNumberGutter('     1→const a = 1;\n     2→\n')).toBe('const a = 1;\n\n');
        expect(stripLineNumberGutter('1→a\nplain')).toBe('1→a\nplain');
    });
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

describe('splitAgentChatWork', () => {
    const thought = { id: 't', type: 'reasoning' as const, text: '**Plan**', streaming: false };
    const ran = (id: string, status: 'running' | 'completed') => ({
        id,
        type: 'command' as const,
        command: 'ls',
        status,
        output: '',
    });
    const ids = (split: ReturnType<typeof splitAgentChatWork>) => ({
        summarized: split.summarized.map((item) => item.id),
        rows: split.rows.map((item) => item.id),
    });

    it('keeps work marked live out of the summary', () => {
        const split = splitAgentChatWork(
            [ran('a', 'completed'), ran('b', 'completed'), ran('c', 'completed')],
            (item) => item.id === 'b',
        );
        expect(ids(split)).toEqual({ summarized: ['a', 'c'], rows: ['b'] });
    });

    it('keeps a thought and a lone call as rows', () => {
        const split = splitAgentChatWork([thought, ran('a', 'completed')]);
        expect(ids(split)).toEqual({ summarized: [], rows: ['t', 'a'] });
    });

    it('summarizes two settled calls and keeps running work as a live row', () => {
        const items = [thought, ran('a', 'completed'), ran('b', 'completed'), ran('c', 'running')];
        expect(ids(splitAgentChatWork(items))).toEqual({
            summarized: ['t', 'a', 'b'],
            rows: ['c'],
        });
    });
});
