import { describe, expect, it } from 'vitest';

import {
    flattenSidebarRows,
    nextSidebarRowId,
    sidebarHorizontalIntent,
    type SidebarProjectNode,
} from './sidebar-tree';

const projects: SidebarProjectNode[] = [
    { id: 'alpha', sessionIds: ['alpha-1', 'alpha-2'] },
    { id: 'beta', sessionIds: ['beta-1'] },
    { id: 'gamma', sessionIds: [] },
];

describe('flattenSidebarRows', () => {
    it('walks each Project heading followed by its Sessions while expanded', () => {
        const rows = flattenSidebarRows(projects, () => true);
        expect(rows.map((row) => row.id)).toEqual([
            'alpha',
            'alpha-1',
            'alpha-2',
            'beta',
            'beta-1',
            'gamma',
        ]);
        expect(rows.find((row) => row.id === 'alpha-2')?.projectId).toBe('alpha');
    });

    it('skips a collapsed Project entirely so focus never lands on a hidden row', () => {
        const rows = flattenSidebarRows(projects, (projectId) => projectId !== 'alpha');
        expect(rows.map((row) => row.id)).toEqual(['alpha', 'beta', 'beta-1', 'gamma']);
    });
});

describe('nextSidebarRowId', () => {
    const rows = flattenSidebarRows(projects, () => true);

    it('moves Down and Up by one row', () => {
        expect(nextSidebarRowId(rows, 'alpha', 'ArrowDown')).toBe('alpha-1');
        expect(nextSidebarRowId(rows, 'alpha-1', 'ArrowUp')).toBe('alpha');
    });

    it('stops at either edge instead of wrapping', () => {
        expect(nextSidebarRowId(rows, 'alpha', 'ArrowUp')).toBeUndefined();
        expect(nextSidebarRowId(rows, 'gamma', 'ArrowDown')).toBeUndefined();
    });

    it('jumps to the first or last row on Home/End regardless of the current row', () => {
        expect(nextSidebarRowId(rows, 'beta-1', 'Home')).toBe('alpha');
        expect(nextSidebarRowId(rows, 'alpha-1', 'End')).toBe('gamma');
    });

    it('recovers to the first row when the active id no longer exists', () => {
        expect(nextSidebarRowId(rows, 'stale-id', 'ArrowDown')).toBe('alpha');
    });

    it('returns undefined for an empty tree', () => {
        expect(nextSidebarRowId([], undefined, 'ArrowDown')).toBeUndefined();
    });
});

describe('sidebarHorizontalIntent', () => {
    const projectRow = { id: 'alpha', kind: 'project' as const, projectId: 'alpha' };
    const sessionRow = { id: 'alpha-1', kind: 'session' as const, projectId: 'alpha' };

    it('opens a collapsed Project on Right and does nothing when already open', () => {
        expect(sidebarHorizontalIntent(projectRow, false, 'ArrowRight')).toEqual({
            expanded: true,
        });
        expect(sidebarHorizontalIntent(projectRow, true, 'ArrowRight')).toEqual({});
    });

    it('closes an open Project on Left and does nothing when already closed', () => {
        expect(sidebarHorizontalIntent(projectRow, true, 'ArrowLeft')).toEqual({
            expanded: false,
        });
        expect(sidebarHorizontalIntent(projectRow, false, 'ArrowLeft')).toEqual({});
    });

    it('moves a Session row to its owning Project on Left and is a no-op on Right', () => {
        expect(sidebarHorizontalIntent(sessionRow, true, 'ArrowLeft')).toEqual({
            focusRowId: 'alpha',
        });
        expect(sidebarHorizontalIntent(sessionRow, true, 'ArrowRight')).toEqual({});
    });
});
