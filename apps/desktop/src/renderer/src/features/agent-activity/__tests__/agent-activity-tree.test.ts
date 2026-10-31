import { describe, expect, it } from 'vitest';

import type { AgentActivityGroup, AgentActivityRow } from '../agent-activity-rows';
import {
    flattenAgentActivityRows,
    nextAgentActivityRowId,
    rovingAgentActivityRowId,
} from '../agent-activity-tree';

function group(id: AgentActivityGroup['id'], sessionIds: readonly string[]): AgentActivityGroup {
    return {
        id,
        rows: sessionIds.map(
            (sessionId) =>
                ({
                    rowId: id === 'pinned' ? `pinned:${sessionId}` : sessionId,
                    session: { id: sessionId },
                }) as AgentActivityRow,
        ),
    };
}

const ids = (rows: ReturnType<typeof flattenAgentActivityRows>) => rows.map((row) => row.id);

const GROUPS = [group('attention', ['a', 'b']), group('idle', ['c'])];
const ROWS = flattenAgentActivityRows(GROUPS);

describe('flattenAgentActivityRows', () => {
    it('emits each heading immediately before its own rows', () => {
        expect(ROWS.map((row) => [row.id, row.kind])).toEqual([
            ['attention', 'group'],
            ['a', 'session'],
            ['b', 'session'],
            ['idle', 'group'],
            ['c', 'session'],
        ]);
    });

    it('keeps the heading but drops the rows of a collapsed group', () => {
        const rows = flattenAgentActivityRows(GROUPS, {
            collapsedGroupIds: new Set(['attention']),
        });
        expect(ids(rows)).toEqual(['attention', 'idle', 'c']);
        expect(rows[0]).toMatchObject({ expanded: false, kind: 'group' });
    });
});

describe('windowed groups', () => {
    const many = (prefix: string, count: number) =>
        Array.from({ length: count }, (_, index) => `${prefix}${index}`);

    it('shows five rows of a long Idle group and a reveal row promising the rest', () => {
        const rows = flattenAgentActivityRows([group('idle', many('i', 7))]);
        expect(ids(rows)).toEqual(['idle', 'i0', 'i1', 'i2', 'i3', 'i4', 'reveal:idle']);
        expect(rows.at(-1)).toMatchObject({ kind: 'reveal', nextRevealCount: 2, windowCount: 5 });
    });

    it('lists every row of a group that asks for the user', () => {
        const rows = flattenAgentActivityRows([
            group('attention', many('a', 7)),
            group('working', many('w', 7)),
        ]);
        expect(rows.filter((row) => row.kind === 'reveal')).toEqual([]);
        expect(rows).toHaveLength(16);
    });

    it('opens a window as far as the user revealed it', () => {
        const rows = flattenAgentActivityRows([group('pinned', many('p', 7))], {
            revealedCounts: { pinned: 15 },
        });
        expect(rows.filter((row) => row.kind === 'session')).toHaveLength(7);
        expect(rows.some((row) => row.kind === 'reveal')).toBe(false);
    });

    it('keeps the selected Session on screen below the window', () => {
        const rows = flattenAgentActivityRows([group('finished', many('f', 8))], {
            selectedSessionId: 'f7',
        });
        expect(ids(rows)).toEqual([
            'finished',
            'f0',
            'f1',
            'f2',
            'f3',
            'f4',
            'f7',
            'reveal:finished',
        ]);
    });
});

describe('Pinned group rows', () => {
    const pinnedGroups = [group('pinned', ['a', 'p']), group('attention', ['a'])];

    it('gives each copy of a Session its own row id', () => {
        expect(ids(flattenAgentActivityRows(pinnedGroups))).toEqual([
            'pinned',
            'pinned:a',
            'pinned:p',
            'attention',
            'a',
        ]);
    });

    it('roves to the selected Session first rendered copy', () => {
        const rows = flattenAgentActivityRows(pinnedGroups);
        expect(rovingAgentActivityRowId(rows, undefined, 'a')).toBe('pinned:a');
        expect(rovingAgentActivityRowId(rows, undefined, undefined)).toBe('pinned');
    });
});

describe('nextAgentActivityRowId', () => {
    it('lands on headings, since every heading collapses its group', () => {
        expect(nextAgentActivityRowId(ROWS, 'b', 'ArrowDown')).toBe('idle');
        expect(nextAgentActivityRowId(ROWS, 'c', 'ArrowUp')).toBe('idle');
    });

    it('skips the rows of a collapsed group', () => {
        const rows = flattenAgentActivityRows(GROUPS, {
            collapsedGroupIds: new Set(['attention']),
        });
        expect(nextAgentActivityRowId(rows, 'attention', 'ArrowDown')).toBe('idle');
    });

    it('stops at both edges instead of wrapping', () => {
        expect(nextAgentActivityRowId(ROWS, 'attention', 'ArrowUp')).toBeUndefined();
        expect(nextAgentActivityRowId(ROWS, 'c', 'ArrowDown')).toBeUndefined();
    });

    it('sends Home and End to the first and last rows', () => {
        expect(nextAgentActivityRowId(ROWS, 'b', 'Home')).toBe('attention');
        expect(nextAgentActivityRowId(ROWS, 'b', 'End')).toBe('c');
    });

    it('recovers to the first row when the remembered row is gone', () => {
        expect(nextAgentActivityRowId(ROWS, 'removed', 'ArrowDown')).toBe('attention');
    });

    it('moves nothing in an empty list', () => {
        expect(nextAgentActivityRowId([], undefined, 'ArrowDown')).toBeUndefined();
    });
});

describe('rovingAgentActivityRowId', () => {
    it('keeps the last focused row', () => {
        expect(rovingAgentActivityRowId(ROWS, 'b', 'a')).toBe('b');
    });

    it('falls back to the selected Session once the focused row is gone', () => {
        expect(rovingAgentActivityRowId(ROWS, 'removed', 'c')).toBe('c');
    });

    it('falls back to the first row when neither is on screen', () => {
        expect(rovingAgentActivityRowId(ROWS, undefined, 'elsewhere')).toBe('attention');
    });
});
