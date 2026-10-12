import type { AgentChatItem, AgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatChangeColor,
    agentChatChangeRows,
    agentChatTurnTone,
    buildAgentChatTimeline,
    withAgentChatPendingEntries,
} from '../agent-chat-timeline';

type Timeline = Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'turns'>;

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
    it('summarizes settled work and keeps work still running as its own rows', () => {
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
        expect(work.summarized.map((item) => item.id)).toEqual(['c1', 'c2']);
        expect(work.rows.map((item) => item.id)).toEqual(['c3', 'r1']);
    });

    it('leaves a single settled tool call as a row rather than a one-item summary', () => {
        const [work] = buildAgentChatTimeline({
            items: [command('c1', 'declined')],
            turns: [{ id: 't1', status: 'running' }],
            activeTurnId: 't1',
        });
        if (work.kind !== 'work') throw new Error('expected a work entry');
        expect(work.summarized).toEqual([]);
        expect(work.rows.map((item) => item.id)).toEqual(['c1']);
    });

    it("ends a finished turn with its artifacts under the final reply, then a footer in Desktop's words", () => {
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
                { id: 'a1', turnId: 't1', type: 'agentMessage', text: 'Done.', streaming: false },
                { id: 'n1', turnId: 't1', type: 'notice', kind: 'compacted' },
            ],
            turns: [{ id: 't1', status: 'completed', durationMs: 65_000 }],
        };
        expect(ids(timeline)).toEqual(['u1', 'work:f1', 'a1', 'artifacts:t1', 'n1', 'turn:t1']);
        const entries = buildAgentChatTimeline(timeline);
        expect(entries.at(-1)).toMatchObject({ label: 'Worked for 1m 5s', status: 'completed' });
        const artifacts = entries[3];
        if (artifacts.kind !== 'artifacts') throw new Error('expected artifacts');
        expect(artifacts.artifacts.files).toMatchObject([
            { path: '/repo/src/a.ts', additions: 1, deletions: 1 },
        ]);
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
        ).toEqual(['work:f1', 'artifacts:t1', 'turn:t1']);
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

    it('labels a turn under a second without a sub-second duration, and failed and stopped turns by outcome', () => {
        const footer = (status: 'completed' | 'failed' | 'interrupted', durationMs?: number) =>
            buildAgentChatTimeline({
                items: [{ id: 'u1', turnId: 't1', type: 'userMessage', text: 'Go' }],
                turns: [{ id: 't1', status, ...(durationMs !== undefined && { durationMs }) }],
            }).at(-1);
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

describe('agentChatTurnTone', () => {
    it('tones a failed turn as danger and a stopped one as a warning', () => {
        expect(agentChatTurnTone('completed')).toBe('muted');
        expect(agentChatTurnTone('failed')).toBe('danger');
        expect(agentChatTurnTone('interrupted')).toBe('warning');
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
