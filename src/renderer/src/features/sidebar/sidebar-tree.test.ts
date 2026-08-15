import { describe, expect, it } from 'vitest';

import type { SidebarProjectNode } from './sidebar-tree';
import {
    flattenSidebarRows,
    nextSidebarRowId,
    rovingSidebarRowId,
    sidebarArchiveIntent,
    sidebarHorizontalIntent,
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

describe('rovingSidebarRowId', () => {
    const rows = flattenSidebarRows(projects, () => true);

    it('prefers the last focused row when it is still present', () => {
        expect(rovingSidebarRowId(rows, 'beta-1', 'alpha-1', 'alpha')).toBe('beta-1');
    });

    it('falls back to the selected Session row when nothing has been focused yet', () => {
        expect(rovingSidebarRowId(rows, undefined, 'beta-1', 'alpha')).toBe('beta-1');
    });

    it('falls back to the selected Project heading when no Session is selected', () => {
        expect(rovingSidebarRowId(rows, undefined, undefined, 'beta')).toBe('beta');
    });

    it('falls back to the first row when nothing is focused or selected', () => {
        expect(rovingSidebarRowId(rows, undefined, undefined, undefined)).toBe('alpha');
    });

    it('falls through the same chain when the focused row no longer exists', () => {
        expect(rovingSidebarRowId(rows, 'stale-id', 'beta-1', 'alpha')).toBe('beta-1');
        expect(rovingSidebarRowId(rows, 'stale-id', undefined, 'beta')).toBe('beta');
        expect(rovingSidebarRowId(rows, 'stale-id', undefined, undefined)).toBe('alpha');
    });

    it('falls through when the selected Session row is hidden by a collapsed Project', () => {
        const collapsedRows = flattenSidebarRows(projects, (projectId) => projectId !== 'alpha');
        expect(rovingSidebarRowId(collapsedRows, 'alpha-1', 'alpha-1', 'alpha')).toBe('alpha');
    });

    it('returns undefined for an empty tree', () => {
        expect(rovingSidebarRowId([], undefined, undefined, undefined)).toBeUndefined();
    });
});

describe('sidebarArchiveIntent', () => {
    const projectRow = { id: 'alpha', kind: 'project' as const, projectId: 'alpha' };
    const sessionRow = { id: 'alpha-1', kind: 'session' as const, projectId: 'alpha' };

    it('resolves Delete and Backspace on a Session row to archive', () => {
        expect(sidebarArchiveIntent(sessionRow, 'Delete')).toBe('archive');
        expect(sidebarArchiveIntent(sessionRow, 'Backspace')).toBe('archive');
    });

    it('is a no-op for any other key on a Session row', () => {
        expect(sidebarArchiveIntent(sessionRow, 'Enter')).toBeUndefined();
    });

    it('is always a no-op for a Project row', () => {
        expect(sidebarArchiveIntent(projectRow, 'Delete')).toBeUndefined();
        expect(sidebarArchiveIntent(projectRow, 'Backspace')).toBeUndefined();
    });
});
