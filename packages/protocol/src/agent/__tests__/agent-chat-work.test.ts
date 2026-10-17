import { describe, expect, it } from 'vitest';

import type { AgentChatItem } from '../agent-chat-contract';
import type { AgentChatWorkItem } from '../agent-chat-work';
import {
    agentChatReasoningTitle,
    agentChatTurnLabel,
    agentChatWorkDuration,
    agentChatWorkGroupFailure,
    agentChatWorkKind,
    agentChatWorkVerb,
    describeAgentChatWork,
    isAgentChatWorkRunning,
    splitAgentChatWork,
    summarizeAgentChatWork,
} from '../agent-chat-work';

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

describe('agentChatTurnLabel', () => {
    it('names how the turn ended', () => {
        expect(agentChatTurnLabel({ status: 'completed', durationMs: 45_000 })).toBe(
            'Worked for 45s',
        );
        expect(agentChatTurnLabel({ status: 'interrupted', durationMs: 3000 })).toBe(
            'Stopped after 3s',
        );
        expect(agentChatTurnLabel({ status: 'failed' })).toBe('Failed');
        expect(agentChatTurnLabel({ status: 'completed', durationMs: 400 })).toBe('Worked');
        expect(agentChatTurnLabel({ status: 'completed', durationMs: 2_999 })).toBe('Worked');
        expect(agentChatTurnLabel({ status: 'completed', durationMs: 3_000 })).toBe(
            'Worked for 3s',
        );
        expect(agentChatTurnLabel({ status: 'failed', durationMs: 300 })).toBe('Failed after <1s');
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
    it('shows successful durations from three seconds and all known failure durations', () => {
        const command = {
            id: 'c',
            type: 'command',
            command: 'ls',
            status: 'completed',
            output: '',
        } as const;
        expect(agentChatWorkDuration({ ...command, durationMs: 300 })).toBeNull();
        expect(agentChatWorkDuration({ ...command, durationMs: 2_999 })).toBeNull();
        expect(agentChatWorkDuration({ ...command, durationMs: 3_000 })).toBe('3s');
        expect(agentChatWorkDuration({ ...command, status: 'failed', durationMs: 300 })).toBe(
            '<1s',
        );
        expect(agentChatWorkDuration({ ...command, status: 'interrupted', durationMs: 0 })).toBe(
            '<1s',
        );
        expect(agentChatWorkDuration(command)).toBeNull();
        const tool = { id: 't', type: 'toolCall', name: 'webSearch', status: 'completed' } as const;
        expect(agentChatWorkDuration({ ...tool, durationMs: 300 })).toBeNull();
        expect(agentChatWorkDuration({ ...tool, durationMs: 2_000 })).toBeNull();
        expect(agentChatWorkDuration({ ...tool, status: 'failed', durationMs: 1_200 })).toBe('1s');
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

    it('groups the first tool immediately while keeping reasoning-only work readable', () => {
        const split = splitAgentChatWork([thought, ran('a', 'completed')]);
        expect(ids(split)).toEqual({ summarized: ['t', 'a'], rows: [] });
        expect(ids(splitAgentChatWork([thought]))).toEqual({ summarized: [], rows: ['t'] });
    });

    it('keeps new running calls in the same group before and after completion', () => {
        const items = [thought, ran('a', 'completed'), ran('b', 'completed'), ran('c', 'running')];
        expect(ids(splitAgentChatWork(items))).toEqual({
            summarized: ['t', 'a', 'b', 'c'],
            rows: [],
        });
    });
});

describe('agentChatWorkVerb', () => {
    it('reads in the present tense while the item runs and keeps the settled verb after', () => {
        const edit = (status: 'completed' | 'failed' | 'running') =>
            agentChatWorkVerb({
                id: 'f',
                type: 'fileChange',
                status,
                changes: [{ path: 'src/a.ts', kind: 'update', diff: '' }],
            });
        expect(edit('running')).toBe('Editing');
        expect(edit('completed')).toBe('Edited');
        expect(edit('failed')).toBe('Failed to edit');
        expect(agentChatWorkVerb({ id: 'r', type: 'reasoning', text: 'x', streaming: true })).toBe(
            'Thinking',
        );
    });
});

describe('isAgentChatWorkRunning', () => {
    it('follows a reasoning stream or a tool status', () => {
        expect(
            isAgentChatWorkRunning({ id: 'r', type: 'reasoning', text: 'x', streaming: true }),
        ).toBe(true);
        expect(isAgentChatWorkRunning(command('c') as AgentChatWorkItem)).toBe(false);
    });
});

describe('agentChatWorkKind', () => {
    it('names the one kind a group shares, or none when it mixes kinds', () => {
        expect(agentChatWorkKind([command('c1'), command('c2')] as AgentChatWorkItem[])).toBe(
            'command',
        );
        expect(
            agentChatWorkKind([command('c1'), read('x')] as AgentChatWorkItem[]),
        ).toBeUndefined();
        expect(agentChatWorkKind([thought('r')] as AgentChatWorkItem[])).toBe('thought');
    });
});
