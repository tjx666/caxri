import type { AgentChatItem, AgentChatTurn } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { AgentChatTimelineEntry } from '../agent-chat-timeline';
import {
    agentChatOutputLanguage,
    agentChatReasoningTitle,
    agentChatTurnLabel,
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

describe('describeAgentChatWork', () => {
    it('shows the inner command of a login-shell wrapper', () => {
        expect(
            describeAgentChatWork({
                id: 'c',
                type: 'command',
                command: `/bin/zsh -lc "sed -n '1,40p' docs/SKILL.md"`,
                status: 'completed',
                output: '',
            }),
        ).toEqual({
            kind: 'command',
            label: 'Ran',
            subject: "sed -n '1,40p' docs/SKILL.md",
            isCodeSubject: true,
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

    it('infers the language of a printed file, a Git diff, or JSON', () => {
        expect(run(`/bin/zsh -lc "sed -n '1,420p' /work/skills/SKILL.md"`)).toBe('md');
        expect(run('cat src/app.ts')).toBe('ts');
        expect(run('git -C repo diff HEAD~1')).toBe('diff');
        expect(run('git show --stat HEAD')).toBeUndefined();
        expect(run('agent-browser skills get core --full | sed -n 1,700p')).toBeUndefined();
        expect(run('gh api repos/a/b', '{"ok": true}')).toBe('json');
        expect(run('ls -la', 'total 0')).toBeUndefined();
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
