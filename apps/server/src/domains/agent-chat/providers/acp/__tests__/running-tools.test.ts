import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatTurnHoldEvent } from '../../chat-turn-hold';
import type { AcpToolCall, AcpToolPresentation } from '../items';
import { AcpRunningTools } from '../running-tools';

const presentation: AcpToolPresentation = {
    nameAndSubject: () => ({ name: 'Bash' }),
    shellCommand: () => 'sleep 60',
    isRejected: () => false,
};

function call(id: string, status: string): AcpToolCall {
    return { id, title: 'Run', kind: 'execute', status, rawInput: {}, content: [] };
}

function setup() {
    const events: ChatTurnHoldEvent[] = [];
    const tools = new AcpRunningTools(
        vi.fn(),
        presentation,
        () => true,
        (event) => events.push(event),
    );
    return { tools, events };
}

describe('AcpRunningTools hold events', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });
    afterEach(() => vi.useRealTimers());

    it('reports a held turn and its release when the call finishes', () => {
        const { tools, events } = setup();
        const finish = vi.fn();
        tools.observe(call('a', 'in_progress'), true);
        tools.observe(call('b', 'in_progress'), true);
        tools.endTurn('completed', finish);
        expect(events).toEqual([{ kind: 'held', holdingCalls: 2 }]);
        vi.advanceTimersByTime(5000);
        tools.observe(call('a', 'completed'), true);
        expect(events).toHaveLength(1);
        tools.observe(call('b', 'completed'), true);
        expect(finish).toHaveBeenCalledOnce();
        expect(events[1]).toEqual({ kind: 'released', reason: 'call_finished', holdMs: 5000 });
    });

    it('reports a Stop release as stopped', () => {
        const { tools, events } = setup();
        tools.observe(call('a', 'in_progress'), true);
        tools.endTurn('completed', vi.fn());
        vi.advanceTimersByTime(300);
        tools.release('interrupted');
        expect(events[1]).toEqual({ kind: 'released', reason: 'stopped', holdMs: 300 });
    });

    it('reports a process end as process_ended and another close as superseded', () => {
        const ended = setup();
        ended.tools.observe(call('a', 'in_progress'), true);
        ended.tools.endTurn('completed', vi.fn());
        vi.advanceTimersByTime(40);
        ended.tools.clear();
        expect(ended.events[1]).toEqual({ kind: 'released', reason: 'process_ended', holdMs: 40 });

        const superseded = setup();
        superseded.tools.observe(call('a', 'in_progress'), true);
        superseded.tools.endTurn('completed', vi.fn());
        superseded.tools.clear('superseded');
        expect(superseded.events[1]).toMatchObject({ kind: 'released', reason: 'superseded' });
    });

    it('emits nothing for a turn no call holds', () => {
        const { tools, events } = setup();
        const finish = vi.fn();
        tools.observe(call('a', 'completed'), true);
        tools.endTurn('completed', finish);
        tools.release('interrupted');
        tools.clear();
        expect(finish).toHaveBeenCalledOnce();
        expect(events).toEqual([]);
    });
});
