import type { AgentChatItem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatChangeColor,
    agentChatChangeRows,
    agentChatRunningTurnIds,
    agentChatTurnTone,
    buildAgentChatTimeline,
    holdEndedTurnsOpen,
    isAgentChatTurnStart,
    toggleAgentChatExpansion,
    withAgentChatAwaitingReply,
    withAgentChatPendingEntries,
} from '../agent-chat-timeline';

type Timeline = Parameters<typeof buildAgentChatTimeline>[0];

const command = (
    id: string,
    status: 'completed' | 'declined' | 'failed' | 'running',
    turnId = 't1',
): AgentChatItem => ({
    id,
    turnId,
    type: 'command',
    command: `echo ${id}`,
    output: '',
    status,
});

const ids = (timeline: Timeline): string[] =>
    buildAgentChatTimeline(timeline).map((entry) => entry.id);

describe('buildAgentChatTimeline', () => {
    it('draws a delegated task pointer as its own turn-starting row', () => {
        const text =
            'Read the delegated task from "/tmp/task.md" and carry it out. Delegation ID: d1.';
        const snapshot = {
            items: [
                {
                    id: 'u1',
                    turnId: 't1',
                    type: 'userMessage',
                    text,
                    delegatedTask: {
                        delegationId: 'd1',
                        source: { kind: 'session', sessionId: 's1' },
                    },
                },
                { id: 'u2', turnId: 't2', type: 'userMessage', text: 'Plain message' },
            ],
            turns: [
                { id: 't1', status: 'completed' },
                { id: 't2', status: 'completed' },
            ],
        } satisfies Parameters<typeof buildAgentChatTimeline>[0];
        const entries = buildAgentChatTimeline(snapshot);
        expect(entries[0]).toEqual({
            kind: 'delegated',
            id: 'u1',
            isExpanded: false,
            text,
            task: { delegationId: 'd1', source: { kind: 'session', sessionId: 's1' } },
        });
        expect(isAgentChatTurnStart(entries[0])).toBe(true);
        expect(entries.find((entry) => entry.id === 'u2')).toMatchObject({ kind: 'message' });
        // The list owns the unfolded pointer, so FlashList re-measures the row instead of a recycled row keeping it.
        expect(buildAgentChatTimeline(snapshot, new Set(['u1']))[0]).toMatchObject({
            isExpanded: true,
        });
    });

    it('groups ordinary work from its first running frame', () => {
        const [work] = buildAgentChatTimeline({
            items: [
                command('c1', 'completed'),
                command('c2', 'failed'),
                command('c3', 'running'),
                {
                    id: 'r1',
                    turnId: 't1',
                    type: 'reasoning',
                    text: '**Checking**',
                    streaming: true,
                },
            ],
            turns: [{ id: 't1', status: 'running' }],
            activeTurnId: 't1',
        });
        expect(work).toMatchObject({ kind: 'work', id: 'work:c1' });
        if (work.kind !== 'work') throw new Error('expected a work entry');
        expect(work.summarized.map((item) => item.id)).toEqual(['c1', 'c2', 'c3', 'r1']);
        expect(work.rows).toEqual([]);
    });

    it('keeps a single tool call in its summary after it settles', () => {
        const [work] = buildAgentChatTimeline({
            items: [command('c1', 'declined')],
            turns: [{ id: 't1', status: 'running' }],
            activeTurnId: 't1',
        });
        if (work.kind !== 'work') throw new Error('expected a work entry');
        expect(work.summarized.map((item) => item.id)).toEqual(['c1']);
        expect(work.rows).toEqual([]);
    });

    it('folds a finished turn behind its Worked for row, with artifacts under the final reply', () => {
        const timeline: Timeline = {
            items: [
                { id: 'u1', turnId: 't1', type: 'userMessage', text: 'Fix it' },
                {
                    id: 'f1',
                    turnId: 't1',
                    type: 'fileChange',
                    status: 'completed',
                    changes: [
                        { path: '/repo/src/a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b' },
                    ],
                },
                {
                    id: 'm1',
                    turnId: 't1',
                    type: 'agentMessage',
                    text: 'Checking.',
                    streaming: false,
                },
                command('c1', 'completed'),
                { id: 'a1', turnId: 't1', type: 'agentMessage', text: 'Done.', streaming: false },
                { id: 'n1', turnId: 't1', type: 'notice', kind: 'compacted' },
            ],
            turns: [{ id: 't1', status: 'completed', durationMs: 65_000 }],
        };
        expect(ids(timeline)).toEqual(['u1', 'turn:t1', 'a1', 'artifacts:t1', 'n1']);
        const entries = buildAgentChatTimeline(timeline);
        expect(entries[1]).toMatchObject({
            label: 'Worked for 1m 5s',
            status: 'completed',
            turnId: 't1',
            fold: 'collapsed',
        });
        const artifacts = entries[3];
        if (artifacts.kind !== 'artifacts') throw new Error('expected artifacts');
        expect(artifacts.artifacts.files).toMatchObject([
            { path: '/repo/src/a.ts', additions: 1, deletions: 1 },
        ]);
        // Expanded, the folded work and commentary follow the row in their original order.
        const expanded = buildAgentChatTimeline(timeline, new Set(['t1']));
        expect(expanded.map((entry) => entry.id)).toEqual([
            'u1',
            'turn:t1',
            'work:f1',
            'm1',
            'work:c1',
            'a1',
            'artifacts:t1',
            'n1',
        ]);
        expect(expanded[1]).toMatchObject({ fold: 'expanded' });
    });

    it('expands only the turns the user opened', () => {
        const turn = (id: string): AgentChatItem[] => [
            { id: `u-${id}`, turnId: id, type: 'userMessage', text: 'Go' },
            command(`c-${id}`, 'completed', id),
            { id: `a-${id}`, turnId: id, type: 'agentMessage', text: 'Done', streaming: false },
        ];
        expect(
            buildAgentChatTimeline(
                {
                    items: [...turn('t1'), ...turn('t2')],
                    turns: [
                        { id: 't1', status: 'completed' },
                        { id: 't2', status: 'completed' },
                    ],
                },
                new Set(['t2']),
            ).map((entry) => entry.id),
        ).toEqual(['u-t1', 'turn:t1', 'a-t1', 'u-t2', 'turn:t2', 'work:c-t2', 'a-t2']);
    });

    it('keeps provider feedback severity, source, and complete details in dedicated cards', () => {
        const notices = [
            {
                id: 'failure',
                type: 'notice' as const,
                kind: 'error' as const,
                title: 'Hook failed',
                message: 'Configuration missing.\nCheck the file.',
            },
            {
                id: 'blocked',
                type: 'notice' as const,
                kind: 'warning' as const,
                title: 'Input blocked by Hook',
                message: 'Choose another input.',
            },
            {
                id: 'command',
                type: 'notice' as const,
                kind: 'output' as const,
                title: 'Example · /display-test',
                message: 'Command result.',
            },
        ];
        expect(buildAgentChatTimeline({ items: notices, turns: [] })).toEqual(
            notices.map((notice) => ({ kind: 'feedback', id: notice.id, notice })),
        );
    });

    it('keeps a static row before the reply when a finished turn had nothing to fold', () => {
        const entries = buildAgentChatTimeline({
            items: [
                { id: 'u1', turnId: 't1', type: 'userMessage', text: 'Hi' },
                { id: 'a1', turnId: 't1', type: 'agentMessage', text: 'Hello', streaming: false },
            ],
            turns: [{ id: 't1', status: 'completed', durationMs: 2000 }],
        });
        expect(entries.map((entry) => entry.id)).toEqual(['u1', 'turn:t1', 'a1']);
        expect(entries[1]).not.toHaveProperty('fold');
    });

    it('places artifacts at the end of a turn that ended without a reply', () => {
        expect(
            ids({
                items: [
                    {
                        id: 'f1',
                        turnId: 't1',
                        type: 'fileChange',
                        status: 'completed',
                        changes: [{ path: 'a.ts', kind: 'add', diff: 'x' }],
                    },
                ],
                turns: [{ id: 't1', status: 'interrupted', durationMs: 4000 }],
            }),
        ).toEqual(['turn:t1', 'artifacts:t1']);
    });

    it('shows no artifacts for the oldest turn when the window cut its start', () => {
        const fileChange = (id: string, turnId: string): AgentChatItem => ({
            id,
            turnId,
            type: 'fileChange',
            status: 'completed',
            changes: [{ path: 'a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b' }],
        });
        const timeline: Timeline = {
            items: [fileChange('f1', 't1'), fileChange('f2', 't2')],
            turns: [
                { id: 't1', status: 'completed' },
                { id: 't2', status: 'completed' },
            ],
        };
        expect(ids(timeline)).toEqual(['turn:t1', 'artifacts:t1', 'turn:t2', 'artifacts:t2']);
        expect(
            buildAgentChatTimeline({ ...timeline, truncated: true }).map((entry) => entry.id),
        ).toEqual(['turn:t1', 'turn:t2', 'artifacts:t2']);
    });

    it('gives a running or active turn neither artifacts nor a footer', () => {
        const items: AgentChatItem[] = [
            {
                id: 'f1',
                turnId: 't1',
                type: 'fileChange',
                status: 'completed',
                changes: [{ path: 'a.ts', kind: 'add', diff: 'x' }],
            },
            { id: 'a1', turnId: 't1', type: 'agentMessage', text: 'Halfway', streaming: true },
        ];
        expect(ids({ items, turns: [{ id: 't1', status: 'running' }] })).toEqual(['work:f1', 'a1']);
        // The projection can settle the turn record a moment before it clears `activeTurnId`.
        expect(
            ids({ items, turns: [{ id: 't1', status: 'completed' }], activeTurnId: 't1' }),
        ).toEqual(['work:f1', 'a1']);
    });

    it('marks only a still-growing reply as streaming so the phone paces it', () => {
        const messages = buildAgentChatTimeline({
            items: [
                { id: 'a1', turnId: 't1', type: 'agentMessage', text: 'Done.', streaming: false },
                { id: 'a2', turnId: 't2', type: 'agentMessage', text: 'Halfway', streaming: true },
            ],
            turns: [
                { id: 't1', status: 'completed' },
                { id: 't2', status: 'running' },
            ],
            activeTurnId: 't2',
        }).flatMap((entry) => (entry.kind === 'message' ? [entry.message] : []));
        expect(messages).toEqual([
            { id: 'a1', type: 'agentMessage', text: 'Done.' },
            { id: 'a2', type: 'agentMessage', text: 'Halfway', streaming: true },
        ]);
    });

    it('labels a turn under a second without a sub-second duration, and failed and stopped turns by outcome', () => {
        const footer = (status: 'completed' | 'failed' | 'interrupted', durationMs?: number) =>
            buildAgentChatTimeline({
                items: [{ id: 'u1', turnId: 't1', type: 'userMessage', text: 'Go' }],
                turns: [{ id: 't1', status, ...(durationMs !== undefined && { durationMs }) }],
            }).find((entry) => entry.kind === 'turn');
        expect(footer('completed', 400)).toMatchObject({ label: 'Worked' });
        expect(footer('failed', 3000)).toMatchObject({ label: 'Failed after 3s' });
        expect(footer('interrupted', 12_000)).toMatchObject({ label: 'Stopped after 12s' });
    });

    it('maps notices to Conversation caveats and drops what has nothing to show', () => {
        const entries = buildAgentChatTimeline({
            items: [
                { id: 'u1', turnId: 't1', type: 'userMessage', text: '', images: [{}] },
                { id: 'r1', turnId: 't1', type: 'reasoning', text: '  ', streaming: false },
                // A reply Stop cut off after a lone newline has nothing to show, as on Desktop.
                { id: 'a1', turnId: 't1', type: 'agentMessage', text: '\n', streaming: false },
                { id: 'n1', turnId: 't1', type: 'notice', kind: 'error', message: 'Rate limited' },
                { id: 'n2', turnId: 't1', type: 'notice', kind: 'retrying' },
            ],
            turns: [{ id: 't1', status: 'running' }],
            activeTurnId: 't1',
        });
        expect(entries.map((entry) => (entry.kind === 'message' ? entry.message : entry))).toEqual([
            { id: 'u1', type: 'userMessage', text: '' },
            {
                id: 'n1',
                type: 'systemEvent',
                kind: 'caveat',
                summary: 'Rate limited',
                status: 'failed',
            },
            { id: 'n2', type: 'systemEvent', kind: 'caveat', summary: 'Retrying' },
        ]);
    });
});

describe('toggleAgentChatExpansion', () => {
    it('opens a folded turn and folds an open one without touching the others', () => {
        const opened = toggleAgentChatExpansion(new Set(['t1']), 't2');
        expect([...opened]).toEqual(['t1', 't2']);
        expect([...toggleAgentChatExpansion(opened, 't1')]).toEqual(['t2']);
    });
});

describe('agentChatTurnTone', () => {
    it('tones a failed turn as danger and a stopped one as a warning', () => {
        expect(agentChatTurnTone('completed')).toBe('muted');
        expect(agentChatTurnTone('failed')).toBe('danger');
        expect(agentChatTurnTone('interrupted')).toBe('warning');
        expect(agentChatTurnTone('interrupted', 'user')).toBe('muted');
    });
});

describe('agentChatChangeRows', () => {
    it("draws a Chat diff in the Changes tab's row shape", () => {
        expect(
            agentChatChangeRows([
                { kind: 'hunk', text: '@@ -1 +1 @@' },
                { kind: 'removed', text: 'a', oldLine: 1 },
                { kind: 'added', text: 'b', newLine: 1 },
                { kind: 'context', text: 'c', oldLine: 2, newLine: 2 },
            ]),
        ).toEqual([
            {
                id: '0',
                kind: 'hunk',
                content: '@@ -1 +1 @@',
                oldLine: null,
                newLine: null,
                marker: ' ',
            },
            { id: '1', kind: 'removed', content: 'a', oldLine: 1, newLine: null, marker: '−' },
            { id: '2', kind: 'added', content: 'b', oldLine: null, newLine: 1, marker: '+' },
            { id: '3', kind: 'context', content: 'c', oldLine: 2, newLine: 2, marker: ' ' },
        ]);
    });

    it('colors each change kind with its Git status color', () => {
        expect(agentChatChangeColor('add')).toBe('gitAdded');
        expect(agentChatChangeColor('delete')).toBe('gitDeleted');
        expect(agentChatChangeColor('update')).toBe('gitModified');
    });
});

describe('withAgentChatPendingEntries', () => {
    it('ends the timeline with recorded answers, then the messages still on their way', () => {
        const built = buildAgentChatTimeline({ items: [], turns: [] });
        expect(withAgentChatPendingEntries(built, { notices: [], timeline: [] })).toBe(built);
        const entries = withAgentChatPendingEntries(built, {
            notices: [
                { id: 'answer:r1', type: 'notice', kind: 'answered', message: 'Color: Blue' },
            ],
            timeline: [{ id: 'p1', text: 'Run the tests', imageUris: ['file:///a.jpg'] }],
        });
        expect(entries.map((entry) => [entry.kind, entry.id])).toEqual([
            ['message', 'pending:answer:r1'],
            ['pending', 'pending:p1'],
        ]);
        expect(entries.at(-1)).toMatchObject({
            text: 'Run the tests',
            imageUris: ['file:///a.jpg'],
        });
    });
});

describe('withAgentChatAwaitingReply', () => {
    const prompt = {
        kind: 'message',
        id: 'u1',
        message: { id: 'u1', type: 'userMessage', text: 'hi' },
    } as const;
    const reply = {
        kind: 'message',
        id: 'a1',
        message: { id: 'a1', type: 'agentMessage', text: 'hello' },
    } as const;
    const running = { activeTurnId: 't1', requests: [] };

    it('holds the reply place under the prompt while the running turn shows nothing', () => {
        expect(withAgentChatAwaitingReply([prompt], running).map(({ kind }) => kind)).toEqual([
            'message',
            'awaiting',
        ]);
    });

    it('shows nothing once the turn has output, is idle, asks, or compacts', () => {
        const entries = [prompt];
        expect(withAgentChatAwaitingReply([prompt, reply], running)).toHaveLength(2);
        expect(withAgentChatAwaitingReply(entries, { requests: [] })).toBe(entries);
        expect(withAgentChatAwaitingReply(entries, undefined)).toBe(entries);
        expect(withAgentChatAwaitingReply(entries, { ...running, operation: 'compacting' })).toBe(
            entries,
        );
        expect(
            withAgentChatAwaitingReply(entries, {
                ...running,
                requests: [{ id: 'r1' } as never],
            }),
        ).toBe(entries);
    });
});

describe('holdEndedTurnsOpen', () => {
    const turn = (status: 'completed' | 'running') => ({
        id: 't1',
        status,
        startedAt: 1,
    });
    const running = { activeTurnId: 't1', turns: [turn('running')] } as Parameters<
        typeof agentChatRunningTurnIds
    >[0];
    const ended = { activeTurnId: undefined, turns: [turn('completed')] } as typeof running;
    const none = new Set<string>();

    it('lists the active and running turns', () => {
        expect([...agentChatRunningTurnIds(running)]).toEqual(['t1']);
        expect([...agentChatRunningTurnIds(ended)]).toEqual([]);
    });

    it('keeps a turn open that ends under a reader who is not following', () => {
        const held = holdEndedTurnsOpen(none, new Set(['t1']), ended, false);
        expect(held.has('t1')).toBe(true);
        // The fold row then draws expanded.
        expect(held).not.toBe(none);
    });

    it('folds the turn as usual for a reader following the end', () => {
        expect(holdEndedTurnsOpen(none, new Set(['t1']), ended, true)).toBe(none);
    });

    it('does nothing while the turn still runs or when it was not running before', () => {
        expect(holdEndedTurnsOpen(none, new Set(['t1']), running, false)).toBe(none);
        expect(holdEndedTurnsOpen(none, none, ended, false)).toBe(none);
    });
});

describe('answered question requests', () => {
    const notice = (answers?: Array<{ question: string; answer: string }>): AgentChatItem => ({
        id: 'answer:r1',
        turnId: 't1',
        type: 'notice',
        kind: 'answered',
        message: 'Split: Per request',
        ...(answers && { answers }),
    });
    const answers = [
        { question: 'How should traffic split?', answer: 'Per request' },
        { question: 'Anything else?', answer: '' },
    ];
    const snapshot = (item: AgentChatItem): Timeline => ({
        items: [item],
        turns: [{ id: 't1', status: 'running' }],
        activeTurnId: 't1',
    });

    it('lists every question with its answer, expanded until the user folds it', () => {
        const [entry] = buildAgentChatTimeline(snapshot(notice(answers)));
        expect(entry).toEqual({ kind: 'answered', id: 'answer:r1', isExpanded: true, answers });
        const [folded] = buildAgentChatTimeline(snapshot(notice(answers)), new Set(['answer:r1']));
        expect(folded).toMatchObject({ kind: 'answered', isExpanded: false });
    });

    it('lists a single question the same way', () => {
        const [entry] = buildAgentChatTimeline(snapshot(notice([answers[0]])));
        expect(entry).toMatchObject({ kind: 'answered', answers: [answers[0]] });
    });

    it('keeps the plain notice for a record without structured answers', () => {
        const [entry] = buildAgentChatTimeline(snapshot(notice()));
        expect(entry).toMatchObject({ kind: 'message' });
    });

    it('draws an answer still on its way as the same list', () => {
        const [entry] = withAgentChatPendingEntries([], {
            notices: [notice(answers)],
            timeline: [],
        });
        expect(entry).toMatchObject({ kind: 'answered', id: 'pending:answer:r1' });
    });
});
