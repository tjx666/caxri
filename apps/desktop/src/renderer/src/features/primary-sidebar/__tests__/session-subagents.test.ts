import type { TerminalRecord, TerminalSubagentSummary } from '@caxri/protocol';
import { agentTaskTabPath } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    activeSubagentTaskId,
    DEFAULT_VISIBLE_SUBAGENT_COUNT,
    orderSubagents,
    rovingSubagentRowId,
    sessionSubagentSummaries,
    subagentWindow,
} from '../session-subagents';

function summary(
    taskId: string,
    status: TerminalSubagentSummary['status'],
    startedAt: number,
    endedAt?: number,
): TerminalSubagentSummary {
    return { taskId, title: taskId, status, startedAt, ...(endedAt !== undefined && { endedAt }) };
}

describe('orderSubagents', () => {
    it('lists running subagents first, then the ended ones by recency', () => {
        const ordered = orderSubagents([
            summary('old-done', 'completed', 1, 10),
            summary('run-old', 'running', 2),
            summary('failed-new', 'failed', 3, 50),
            summary('run-new', 'running', 9),
            summary('stopped', 'stopped', 4, 30),
        ]);
        expect(ordered.map((item) => item.taskId)).toEqual([
            'run-new',
            'run-old',
            'failed-new',
            'stopped',
            'old-done',
        ]);
    });

    it('breaks a recency tie by task id so the order is stable across refreshes', () => {
        const ordered = orderSubagents([
            summary('b', 'completed', 1, 5),
            summary('a', 'completed', 1, 5),
        ]);
        expect(ordered.map((item) => item.taskId)).toEqual(['a', 'b']);
    });
});

describe('subagentWindow', () => {
    const many = Array.from({ length: 5 }, (_, index) =>
        summary(`t${index}`, 'completed', index, index + 1),
    );

    it('shows the newest few and reports how many are hidden', () => {
        const window = subagentWindow(many, false);
        expect(window.visible.map((item) => item.taskId)).toEqual(['t4', 't3', 't2']);
        expect(window).toMatchObject({ hiddenCount: 2, toggleIndex: 3 });
        expect(window.visible).toHaveLength(DEFAULT_VISIBLE_SUBAGENT_COUNT);
    });

    it('shows everything once expanded and keeps the toggle in place so it can fold again', () => {
        const window = subagentWindow(many, true);
        expect(window.visible).toHaveLength(5);
        expect(window).toMatchObject({
            hiddenCount: 0,
            toggleIndex: DEFAULT_VISIBLE_SUBAGENT_COUNT,
        });
    });

    it('needs no toggle when everything fits', () => {
        const window = subagentWindow(many.slice(0, 3), false);
        expect(window).toMatchObject({ hiddenCount: 0 });
        expect(window.toggleIndex).toBeUndefined();
    });
});

describe('sessionSubagentSummaries', () => {
    const subagents = [summary('t1', 'running', 1)];
    const terminal = (fields: Partial<TerminalRecord>): TerminalRecord =>
        ({ id: 'term', ...fields }) as TerminalRecord;

    it('returns the Chat Terminal subagents while the Setting is on', () => {
        expect(sessionSubagentSummaries(terminal({ surface: 'chat', subagents }), true)).toBe(
            subagents,
        );
    });

    it('returns none for a PTY Agent, a missing Terminal, or the Setting turned off', () => {
        expect(sessionSubagentSummaries(terminal({ subagents }), true)).toEqual([]);
        expect(sessionSubagentSummaries(undefined, true)).toEqual([]);
        expect(sessionSubagentSummaries(terminal({ surface: 'chat', subagents }), false)).toEqual(
            [],
        );
    });
});

describe('rovingSubagentRowId', () => {
    it('passes the roving row only to the Session that owns it', () => {
        expect(rovingSubagentRowId('subagent:s1:t1', 's1')).toBe('subagent:s1:t1');
        expect(rovingSubagentRowId('subagent-more:s1', 's1')).toBe('subagent-more:s1');
        expect(rovingSubagentRowId('subagent:s2:t1', 's1')).toBeUndefined();
        expect(rovingSubagentRowId('s1', 's1')).toBeUndefined();
        expect(rovingSubagentRowId(undefined, 's1')).toBeUndefined();
    });
});

describe('activeSubagentTaskId', () => {
    it('returns the task of the active task tab of the same Chat', () => {
        const resource = { kind: 'file', path: agentTaskTabPath('t1', 'task-9') } as const;
        expect(activeSubagentTaskId(resource, 't1')).toBe('task-9');
    });

    it('ignores another Chat, other resources, and a missing Terminal', () => {
        const resource = { kind: 'file', path: agentTaskTabPath('t2', 'task-9') } as const;
        expect(activeSubagentTaskId(resource, 't1')).toBeUndefined();
        expect(activeSubagentTaskId({ kind: 'file', path: '/a.ts' }, 't1')).toBeUndefined();
        expect(activeSubagentTaskId({ kind: 'terminal', terminalId: 't1' }, 't1')).toBeUndefined();
        expect(activeSubagentTaskId(resource, undefined)).toBeUndefined();
        expect(activeSubagentTaskId(undefined, 't1')).toBeUndefined();
    });
});
