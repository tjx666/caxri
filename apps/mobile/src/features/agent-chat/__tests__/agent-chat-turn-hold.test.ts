import type { AgentChatItem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatRunningTurnIds,
    buildAgentChatTimeline,
    holdEndedTurnsOpen,
} from '../agent-chat-timeline';

const command = (id: string): AgentChatItem => ({
    id,
    turnId: 't1',
    type: 'command',
    command: `echo ${id}`,
    output: '',
    status: 'completed',
});

describe('holdEndedTurnsOpen', () => {
    const turn = (status: 'completed' | 'running') => ({
        id: 't1',
        status,
        startedAt: 1,
    });
    const running = { activeTurnId: 't1', items: [], turns: [turn('running')] };
    const ended = { activeTurnId: undefined, items: [], turns: [turn('completed')] };
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

    it('keeps every fold open that steered messages split the ended turn into', () => {
        const items: AgentChatItem[] = [
            { id: 'u1', turnId: 't1', type: 'userMessage', text: 'Go' },
            command('c1'),
            { id: 'u2', turnId: 't1', type: 'userMessage', text: 'Also' },
            command('c2'),
        ];
        const held = holdEndedTurnsOpen(none, new Set(['t1']), { ...ended, items }, false);
        expect([...held]).toEqual(['t1', 't1:1', 't1:2']);
        expect(
            buildAgentChatTimeline({ items, turns: [turn('completed')] }, held).map(
                (entry) => entry.id,
            ),
        ).toEqual(['u1', 'turn:t1', 'work:c1', 'u2', 'turn:t1:1', 'work:c2']);
    });

    it('folds the turn as usual for a reader following the end', () => {
        expect(holdEndedTurnsOpen(none, new Set(['t1']), ended, true)).toBe(none);
    });

    it('does nothing while the turn still runs or when it was not running before', () => {
        expect(holdEndedTurnsOpen(none, new Set(['t1']), running, false)).toBe(none);
        expect(holdEndedTurnsOpen(none, none, ended, false)).toBe(none);
    });
});
