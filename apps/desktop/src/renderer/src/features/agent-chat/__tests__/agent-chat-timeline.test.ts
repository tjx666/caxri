import type { AgentChatItem, AgentChatTurn } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { AgentChatTimelineEntry } from '../agent-chat-timeline';
import {
    agentChatTurnLabel,
    agentChatTurnTimeTooltip,
    agentChatTurnTone,
    buildAgentChatTimeline,
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
              : entry.kind === 'artifacts'
                ? entry.id
                : { [agentChatTurnLabel(entry)]: shape(entry.entries) },
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

    it("hangs a finished turn's changed files on its final reply, or after the turn without one", () => {
        const change = (id: string, turnId: string): AgentChatItem => ({
            id,
            turnId,
            type: 'fileChange',
            status: 'completed',
            changes: [{ path: `/p/${id}.ts`, kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b' }],
        });
        const turns: AgentChatTurn[] = [
            { id: 't1', status: 'completed' },
            { id: 't2', status: 'interrupted' },
        ];
        const items = [
            user('u1', 't1'),
            change('f1', 't1'),
            reply('a1', 't1'),
            user('u2', 't2'),
            change('f2', 't2'),
        ];
        const entries = buildAgentChatTimeline(items, turns, undefined);
        expect(shape(entries)).toEqual([
            'u1',
            { Worked: [['f1']] },
            'a1',
            'u2',
            { Stopped: [['f2']] },
            'artifacts:t2',
        ]);
        const artifactsOf = (entry: AgentChatTimelineEntry | undefined) =>
            entry?.kind === 'item' ? entry.artifacts : undefined;
        const final = artifactsOf(entries.at(2));
        expect(final?.files.map((file) => file.path)).toEqual(['/p/f1.ts']);
        // A rebuild over the same items reuses the artifacts, so a memoized reply does not re-render.
        expect(artifactsOf(buildAgentChatTimeline([...items], turns, undefined).at(2))).toBe(final);
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

    it('keeps Copy in view only on the final reply of the most recent turn', () => {
        const latest = (entries: readonly AgentChatTimelineEntry[]): string[] =>
            entries.flatMap((entry) =>
                entry.kind === 'item' && entry.isLatestReply ? [entry.item.id] : [],
            );
        const items = [
            user('u1', 't1'),
            command('c1', 't1'),
            reply('a1', 't1'),
            user('u2', 't2'),
            command('c2', 't2'),
            reply('a2', 't2'),
        ];
        const done: AgentChatTurn[] = [
            { id: 't1', status: 'completed', durationMs: 1000 },
            { id: 't2', status: 'completed', durationMs: 1000 },
        ];
        expect(latest(buildAgentChatTimeline(items, done, undefined))).toEqual(['a2']);
        // While the last turn runs it has no final reply, and the previous turn's reply is no longer the latest.
        const running: AgentChatTurn[] = [done[0], { id: 't2', status: 'running' }];
        expect(latest(buildAgentChatTimeline(items, running, 't2'))).toEqual([]);
    });

    it('carries when a folded turn started and ended for its tooltip', () => {
        const items = [user('u', 't1'), command('c', 't1'), reply('a', 't1')];
        const [, fold] = buildAgentChatTimeline(
            items,
            [{ id: 't1', status: 'completed', startedAt: 1000, durationMs: 2500 }],
            undefined,
        );
        expect(fold).toMatchObject({ kind: 'turn', startedAt: 1000, endedAt: 3500 });
        expect(agentChatTurnTimeTooltip({ startedAt: 1000, endedAt: 3500 })).toMatch(/^Finished /);
        expect(agentChatTurnTimeTooltip({ startedAt: 1000 })).toMatch(/^Started /);
        expect(agentChatTurnTimeTooltip({})).toBeUndefined();
    });

    it('skips empty reasoning', () => {
        const items: AgentChatItem[] = [
            { id: 'r', type: 'reasoning', text: '', streaming: true },
            command('c'),
        ];
        expect(shape(buildAgentChatTimeline(items, [], undefined))).toEqual([['c']]);
    });

    it('drops a reply that ended empty, so a stopped turn ends on the reply before it', () => {
        const empty: AgentChatItem = {
            id: 'a2',
            turnId: 't1',
            type: 'agentMessage',
            text: ' ',
            streaming: false,
        };
        const items = [user('u', 't1'), reply('a1', 't1'), command('c', 't1'), empty];
        const stopped = buildAgentChatTimeline(
            items,
            [{ id: 't1', status: 'interrupted', durationMs: 1000 }],
            undefined,
        );
        expect(shape(stopped)).toEqual(['u', 'a1', { 'Stopped after 1s': [['c']] }]);
        expect(stopped[1]).toMatchObject({ kind: 'item', isFinalReply: true });
        // While the turn runs, the empty reply is the one about to stream, so it stays.
        const streaming = buildAgentChatTimeline(
            [user('u', 't1'), { ...empty, streaming: true }],
            [{ id: 't1', status: 'running' }],
            't1',
        );
        expect(shape(streaming)).toEqual(['u', 'a2']);
    });
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
    });
});

describe('agentChatTurnTone', () => {
    it('tones a failed or stopped turn and keeps a completed one quiet', () => {
        expect(agentChatTurnTone('failed')).toBe('danger');
        expect(agentChatTurnTone('interrupted')).toBe('warning');
        expect(agentChatTurnTone('completed')).toBeUndefined();
    });
});
