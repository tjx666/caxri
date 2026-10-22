import type { AgentChatItem, AgentChatTurn } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { buildAgentChatTimeline } from '../agent-chat-timeline';

const user = (id: string, turnId: string): AgentChatItem => ({
    id,
    turnId,
    type: 'userMessage',
    text: 'hi',
});
const reply = (id: string, turnId: string, text = 'done', isStreaming = false): AgentChatItem => ({
    id,
    turnId,
    type: 'agentMessage',
    text,
    streaming: isStreaming,
});
const command = (id: string, turnId: string): AgentChatItem => ({
    id,
    turnId,
    type: 'command',
    command: 'git status',
    status: 'completed',
    output: '',
});
const turn = (id: string, status: AgentChatTurn['status']): AgentChatTurn => ({ id, status });

describe('buildAgentChatTimeline entry reuse', () => {
    const settled = [user('u1', 't1'), command('c1', 't1'), reply('r1', 't1')];
    const turns = [turn('t1', 'completed'), turn('t2', 'running')];

    it('keeps every settled entry identical while a later turn streams', () => {
        const before = buildAgentChatTimeline(
            [...settled, user('u2', 't2'), reply('r2', 't2', 'a', true)],
            turns,
            't2',
        );
        const after = buildAgentChatTimeline(
            [...settled, user('u2', 't2'), reply('r2', 't2', 'ab', true)],
            turns,
            't2',
        );
        const settledCount = before.findIndex(
            (entry) => entry.kind === 'item' && entry.item.id === 'u2',
        );
        expect(settledCount).toBeGreaterThan(0);
        for (let index = 0; index < settledCount; index += 1)
            expect(after[index]).toBe(before[index]);
        expect(after.at(-1)).not.toBe(before.at(-1));
    });

    it('rebuilds an entry whose own items changed', () => {
        const items = [user('u1', 't1'), reply('r1', 't1', 'one')];
        const before = buildAgentChatTimeline(items, [turn('t1', 'completed')], undefined);
        const after = buildAgentChatTimeline(
            [items[0], reply('r1', 't1', 'two')],
            [turn('t1', 'completed')],
            undefined,
        );
        expect(after[0]).toBe(before[0]);
        expect(after[1]).not.toBe(before[1]);
    });

    it('rebuilds a turn fold when the turn ends differently', () => {
        const items = [user('u1', 't1'), command('c1', 't1'), reply('r1', 't1')];
        const before = buildAgentChatTimeline(items, [turn('t1', 'completed')], undefined);
        const after = buildAgentChatTimeline(items, [turn('t1', 'failed')], undefined);
        const fold = (entries: typeof before) => entries.find((entry) => entry.kind === 'turn');
        expect(fold(before)).toBeDefined();
        expect(fold(after)).not.toBe(fold(before));
    });
});
