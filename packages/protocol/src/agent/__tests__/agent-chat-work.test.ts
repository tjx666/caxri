import { describe, expect, it } from 'vitest';

import type { AgentChatItem } from '../agent-chat-contract';
import type { AgentChatWorkItem } from '../agent-chat-work';
import {
    agentChatTurnActiveWork,
    agentChatTurnLabel,
    agentChatWorkDuration,
    agentChatWorkGroupFailure,
    agentChatWorkKind,
    agentChatWorkSummaryGlyph,
    agentChatWorkSummaryItems,
    agentChatWorkSummaryPhrases,
    agentChatWorkVerb,
    describeAgentChatWork,
    isAgentChatWaitingOnAgents,
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
const read = (id: string, turnId?: string): Extract<AgentChatItem, { type: 'toolCall' }> => ({
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

    it('says who stopped a turn when Caxri relayed the Stop', () => {
        expect(
            agentChatTurnLabel({ status: 'interrupted', durationMs: 67_000, stoppedBy: 'user' }),
        ).toBe('Stopped by you after 1m 7s');
        expect(agentChatTurnLabel({ status: 'interrupted', stoppedBy: 'agent' })).toBe(
            'Stopped by an Agent',
        );
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
                command: 'make build',
                status: 'interrupted',
                output: '',
            }).label,
        ).toBe('Stopped running');
        expect(
            describeAgentChatWork({
                id: 't',
                type: 'command',
                command: 'npm test',
                status: 'failed',
                output: '',
            }).label,
        ).toBe('Failed to run tests');
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

describe('agentChatWorkSummaryItems', () => {
    const settled: AgentChatWorkItem = {
        id: 'settled',
        type: 'command',
        command: 'printf settled',
        output: '',
        status: 'completed',
    };
    const running: AgentChatWorkItem = {
        id: 'running',
        type: 'command',
        command: 'printf running',
        output: '',
        status: 'running',
    };

    it('keeps a settled summary while a brief call runs, then describes the call once it is shown', () => {
        expect(summarizeAgentChatWork(agentChatWorkSummaryItems([settled, running], false))).toBe(
            'Ran 1 command',
        );
        expect(summarizeAgentChatWork(agentChatWorkSummaryItems([settled, running], true))).toBe(
            'Running printf running',
        );
    });

    it('describes running work at once when nothing has settled yet', () => {
        expect(summarizeAgentChatWork(agentChatWorkSummaryItems([running], false))).toBe(
            'Running printf running',
        );
    });
});

describe('agentChatWorkSummaryPhrases', () => {
    const command: AgentChatWorkItem = {
        id: 'command',
        type: 'command',
        command: 'printf done',
        output: '',
        status: 'completed',
    };
    const failed: AgentChatWorkItem = { ...command, id: 'failed', status: 'failed' };
    const edit: AgentChatWorkItem = {
        id: 'edit',
        type: 'fileChange',
        changes: [{ path: 'src/app.ts', kind: 'update', diff: '' }],
        status: 'completed',
    };

    it('keys one phrase per kind, so a count change keeps its key and a new kind adds one', () => {
        expect(agentChatWorkSummaryPhrases([command])).toEqual([
            { key: 'command', text: 'Ran 1 command' },
        ]);
        expect(agentChatWorkSummaryPhrases([command, command, edit])).toEqual([
            { key: 'command', text: 'Ran 2 commands' },
            { key: 'edit', text: ', edited 1 file' },
        ]);
    });

    it('names the current step of an open group between calls and counts only once it ends', () => {
        const second: AgentChatWorkItem = { ...command, id: 'second', command: 'printf second' };
        const reasoning: AgentChatWorkItem = {
            id: 'reasoning',
            type: 'reasoning',
            text: '',
            streaming: false,
        };
        expect(
            agentChatWorkSummaryPhrases([command, second, reasoning], undefined, { isOpen: true }),
        ).toEqual([{ key: 'active', text: 'Running printf second' }]);
        expect(agentChatWorkSummaryPhrases([command, second])).toEqual([
            { key: 'command', text: 'Ran 2 commands' },
        ]);
    });

    it('counts the other calls running beside the one the title names', () => {
        const first: AgentChatWorkItem = {
            ...command,
            id: 'first',
            command: 'printf first',
            status: 'running',
        };
        const second: AgentChatWorkItem = { ...first, id: 'second', command: 'printf second' };
        const third: AgentChatWorkItem = { ...first, id: 'third', command: 'printf third' };
        expect(
            agentChatWorkSummaryPhrases([first, second, third], undefined, { isOpen: true }),
        ).toEqual([{ key: 'active', text: 'Running printf third and 2 more' }]);
        // The newest call ends first: the title names a call still running and counts the rest.
        const settled: AgentChatWorkItem = { ...third, status: 'completed' };
        expect(
            agentChatWorkSummaryPhrases([first, second, settled], undefined, { isOpen: true }),
        ).toEqual([{ key: 'active', text: 'Running printf second and 1 more' }]);
        expect(
            agentChatWorkSummaryPhrases([first, { ...second, status: 'completed' }, settled]),
        ).toEqual([{ key: 'active', text: 'Running printf first' }]);
    });

    it('leads parallel calls of different kinds with the generic work glyph', () => {
        const running: AgentChatWorkItem = { ...command, status: 'running' };
        const reading: AgentChatWorkItem = { ...edit, status: 'running' };
        expect(agentChatWorkSummaryGlyph([running, reading], { isOpen: true })).toEqual({
            kind: 'other',
        });
        expect(
            agentChatWorkSummaryGlyph([running, { ...running, id: 'again' }], { isOpen: true }),
        ).toEqual({
            kind: 'command',
        });
    });

    it('ends with the failure count and joins into the summary text', () => {
        const phrases = agentChatWorkSummaryPhrases([edit, failed]);
        expect(phrases.at(-1)).toEqual({ key: 'failures', text: ', 1 failed' });
        expect(phrases.map(({ text }) => text).join('')).toBe(
            summarizeAgentChatWork([edit, failed]),
        );
    });
});

describe('summarizeAgentChatWork', () => {
    it('shows the current command while running and counts work only after it settles', () => {
        const first: AgentChatWorkItem = {
            id: 'first',
            type: 'command',
            command: 'printf first',
            output: '',
            status: 'running',
        };
        const second: AgentChatWorkItem = {
            id: 'second',
            type: 'command',
            command: 'printf second',
            output: '',
            status: 'running',
        };
        expect(summarizeAgentChatWork([first])).toBe('Running printf first');
        expect(summarizeAgentChatWork([first, second])).toBe('Running printf second and 1 more');
        expect(summarizeAgentChatWork([first, { ...second, status: 'completed' }])).toBe(
            'Running printf first',
        );
        expect(
            summarizeAgentChatWork([
                { ...first, status: 'completed' },
                { ...second, status: 'completed' },
            ]),
        ).toBe('Ran 2 commands');
    });

    it('shows the active action and target for tools other than commands', () => {
        expect(summarizeAgentChatWork([{ ...read('read'), status: 'running' }])).toBe(
            'Reading app.ts',
        );
        expect(
            summarizeAgentChatWork([
                {
                    id: 'edit',
                    type: 'fileChange',
                    status: 'running',
                    changes: [{ path: '/work/src/app.ts', kind: 'update', diff: '' }],
                },
            ]),
        ).toBe('Editing app.ts');
    });

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

describe('isAgentChatWaitingOnAgents', () => {
    const wait = (status: 'completed' | 'running'): AgentChatItem => ({
        id: 'w',
        turnId: 'turn-1',
        type: 'toolCall',
        name: 'wait',
        status,
        createdAt: 5,
    });

    it('is true only while the active turn is in a running wait', () => {
        expect(
            isAgentChatWaitingOnAgents({ activeTurnId: 'turn-1', items: [wait('running')] }),
        ).toBe(true);
        expect(
            isAgentChatWaitingOnAgents({ activeTurnId: 'turn-1', items: [wait('completed')] }),
        ).toBe(false);
        expect(isAgentChatWaitingOnAgents({ items: [wait('running')] })).toBe(false);
        expect(
            isAgentChatWaitingOnAgents({
                activeTurnId: 'turn-1',
                items: [
                    wait('running'),
                    { ...read('r', 'turn-1'), status: 'running', createdAt: 9 },
                ],
            }),
        ).toBe(false);
    });
});

describe('agentChatTurnActiveWork', () => {
    const running = <T extends AgentChatItem>(item: T, createdAt: number): T =>
        item.type === 'reasoning'
            ? { ...item, streaming: true, createdAt }
            : { ...item, status: 'running', createdAt };

    it('names the newest running tool of the active turn and when it began', () => {
        const items = [
            running(command('old', 'turn-0'), 1),
            running(thought('t', 'turn-1'), 10),
            running(read('r', 'turn-1'), 20),
        ];
        expect(agentChatTurnActiveWork(items, 'turn-1')).toEqual({ kind: 'read', startedAt: 20 });
    });

    it('falls back to streaming reasoning, and to nothing between steps', () => {
        const thinking = [command('c', 'turn-1'), running(thought('t', 'turn-1'), 30)];
        expect(agentChatTurnActiveWork(thinking, 'turn-1')).toEqual({
            kind: 'thought',
            startedAt: 30,
        });
        expect(
            agentChatTurnActiveWork([command('c', 'turn-1'), read('r', 'turn-1')], 'turn-1'),
        ).toBeUndefined();
    });

    it('ignores work an earlier turn left running', () => {
        const items = [running(command('stale', 'turn-0'), 1), thought('t', 'turn-1')];
        expect(agentChatTurnActiveWork(items, 'turn-1')).toBeUndefined();
    });
});
