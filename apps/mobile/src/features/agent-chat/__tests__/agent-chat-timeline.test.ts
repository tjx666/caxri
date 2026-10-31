import type { AgentChatItem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { withAgentChatAwayRecap } from '../agent-chat-away-recap-entry';
import type { AgentChatTimelineEntry } from '../agent-chat-timeline';
import {
    agentChatChangeColor,
    agentChatChangeRows,
    agentChatTurnTone,
    buildAgentChatTimeline,
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

    it("keeps the running turn's trailing lone call in an open summary so a second call does not reshape it", () => {
        const [work] = buildAgentChatTimeline({
            items: [command('c1', 'declined')],
            turns: [{ id: 't1', status: 'running' }],
            activeTurnId: 't1',
        });
        if (work.kind !== 'work') throw new Error('expected a work entry');
        expect(work.isOpen).toBe(true);
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

    it('keeps the subagents a collapsed turn started in reach of its row', () => {
        const subagent: AgentChatItem = {
            id: 'toolu-1',
            turnId: 't1',
            type: 'toolCall',
            name: 'Agent',
            status: 'completed',
        };
        const timeline: Timeline = {
            items: [
                { id: 'u1', turnId: 't1', type: 'userMessage', text: 'Watch the build' },
                command('c1', 'completed'),
                subagent,
                {
                    id: 'a1',
                    turnId: 't1',
                    type: 'agentMessage',
                    text: 'Started.',
                    streaming: false,
                },
            ],
            turns: [{ id: 't1', status: 'completed' }],
        };
        expect(buildAgentChatTimeline(timeline)[1]).toMatchObject({
            kind: 'turn',
            fold: 'collapsed',
            subagents: [subagent],
        });
        // Expanded, the subagent draws in its place among the work, and the row lists none.
        expect(buildAgentChatTimeline(timeline, new Set(['t1']))[1]).not.toHaveProperty(
            'subagents',
        );
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

    it('says how a steered turn stopped under its last segment when that segment folded nothing', () => {
        const entries = buildAgentChatTimeline({
            items: [
                { id: 'u1', turnId: 't1', type: 'userMessage', text: 'Go', createdAt: 0 },
                command('c1', 'completed'),
                { id: 'a1', turnId: 't1', type: 'agentMessage', text: 'One', streaming: false },
                { id: 'u2', turnId: 't1', type: 'userMessage', text: 'Also', createdAt: 60_000 },
                { id: 'a2', turnId: 't1', type: 'agentMessage', text: 'Two', streaming: false },
            ],
            turns: [{ id: 't1', status: 'interrupted', startedAt: 0, durationMs: 90_000 }],
        });
        expect(entries.map((entry) => entry.id)).toEqual([
            'u1',
            'turn:t1',
            'a1',
            'u2',
            'turn:t1:1',
            'a2',
        ]);
        expect(entries[1]).toMatchObject({ label: 'Worked for 1m', status: 'completed' });
        expect(entries[4]).toMatchObject({ label: 'Stopped after 30s', status: 'interrupted' });
        expect(entries[4]).not.toHaveProperty('fold');
    });

    it('folds a steered turn per segment, each timed and expanded on its own', () => {
        const timeline: Timeline = {
            items: [
                { id: 'u1', turnId: 't1', type: 'userMessage', text: 'Go', createdAt: 0 },
                command('c1', 'completed'),
                { id: 'a1', turnId: 't1', type: 'agentMessage', text: 'One', streaming: false },
                { id: 'u2', turnId: 't1', type: 'userMessage', text: 'Also', createdAt: 60_000 },
                command('c2', 'completed'),
                { id: 'a2', turnId: 't1', type: 'agentMessage', text: 'Two', streaming: false },
            ],
            turns: [{ id: 't1', status: 'interrupted', startedAt: 0, durationMs: 90_000 }],
        };
        const entries = buildAgentChatTimeline(timeline);
        expect(entries.map((entry) => entry.id)).toEqual([
            'u1',
            'turn:t1',
            'a1',
            'u2',
            'turn:t1:1',
            'a2',
        ]);
        expect(entries[1]).toMatchObject({
            label: 'Worked for 1m',
            status: 'completed',
            foldKey: 't1',
        });
        expect(entries[4]).toMatchObject({
            label: 'Stopped after 30s',
            status: 'interrupted',
            foldKey: 't1:1',
        });
        expect(
            buildAgentChatTimeline(timeline, new Set(['t1:1'])).map((entry) => entry.id),
        ).toEqual(['u1', 'turn:t1', 'a1', 'u2', 'turn:t1:1', 'work:c2', 'a2']);
    });

    it('keeps provider feedback severity, source, and complete details in dedicated cards', () => {
        const notices: Array<Extract<AgentChatItem, { type: 'notice' }>> = [
            {
                id: 'failure',
                type: 'notice' as const,
                kind: 'error' as const,
                heading: { kind: 'hook', outcome: 'failed', hook: 'Example' },
                message: 'Configuration missing.\nCheck the file.',
            },
            {
                id: 'blocked',
                type: 'notice' as const,
                kind: 'warning' as const,
                heading: { kind: 'event', event: 'inputBlocked' },
                message: 'Choose another input.',
            },
            {
                id: 'command',
                type: 'notice' as const,
                kind: 'output' as const,
                heading: { kind: 'command', plugin: 'Example', command: 'display-test' },
                message: 'Command result.',
            },
            // A used-up plan limit has no heading, but its card carries the wait and its actions.
            {
                id: 'limit',
                type: 'notice' as const,
                kind: 'error' as const,
                message: "You've hit your session limit",
                usageLimit: { window: 'session' as const, resetsAt: 1 },
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

    it('keeps the artifacts of the oldest turn when the window cut its start', () => {
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
        ).toEqual(['turn:t1', 'artifacts:t1', 'turn:t2', 'artifacts:t2']);
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

describe('withAgentChatAwayRecap', () => {
    const reply: AgentChatTimelineEntry = {
        kind: 'message',
        id: 'a1',
        message: { id: 'a1', type: 'agentMessage', text: 'Done.' },
    };
    const recap = { text: 'Shipped the fix.', lastResponseAt: 100, generatedAt: 200 };
    const snapshot = { activeTurnId: undefined, awayRecap: recap, usage: { lastResponseAt: 100 } };

    it('adds the current recap after the last reply', () => {
        const entries = withAgentChatAwayRecap([reply], snapshot as never, undefined);
        expect(entries.at(-1)).toEqual({
            kind: 'awayRecap',
            id: 'away-recap',
            generatedAt: 200,
            text: 'Shipped the fix.',
        });
    });

    it('leaves out a recap the user closed, but not the next one', () => {
        expect(withAgentChatAwayRecap([reply], snapshot as never, 200)).toEqual([reply]);
        expect(withAgentChatAwayRecap([reply], snapshot as never, 150)).toHaveLength(2);
    });

    it('drops the recap once a turn runs or a newer reply landed', () => {
        const running = { ...snapshot, activeTurnId: 't2' };
        expect(withAgentChatAwayRecap([reply], running as never, undefined)).toEqual([reply]);
        const replied = { ...snapshot, usage: { lastResponseAt: 300 } };
        expect(withAgentChatAwayRecap([reply], replied as never, undefined)).toEqual([reply]);
    });

    it('shows nothing without a recap', () => {
        expect(withAgentChatAwayRecap([reply], undefined, undefined)).toEqual([reply]);
    });

    it('leaves with a message still on its way', () => {
        const pending: AgentChatTimelineEntry = {
            kind: 'pending',
            id: 'p1',
            text: 'next',
            imageUris: [],
        };
        expect(withAgentChatAwayRecap([reply, pending], snapshot as never, undefined)).toEqual([
            reply,
            pending,
        ]);
    });
});
