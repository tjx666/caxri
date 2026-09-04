import { describe, expect, it } from 'vitest';

import type { PrimarySidebarProjectNode } from '../primary-sidebar-tree';
import {
    flattenPrimarySidebarRows,
    nextPrimarySidebarRowId,
    primarySidebarArchiveIntent,
    primarySidebarHorizontalIntent,
    primarySidebarRevealRowId,
    rovingPrimarySidebarRowId,
} from '../primary-sidebar-tree';

const projects: PrimarySidebarProjectNode[] = [
    { id: 'alpha', sessionIds: ['alpha-1', 'alpha-2'] },
    { id: 'beta', sessionIds: ['beta-1'] },
    { id: 'gamma', sessionIds: [] },
];

describe('flattenPrimarySidebarRows', () => {
    it('walks each Project heading followed by its Sessions while expanded', () => {
        const rows = flattenPrimarySidebarRows(projects, () => true);
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
        const rows = flattenPrimarySidebarRows(projects, (projectId) => projectId !== 'alpha');
        expect(rows.map((row) => row.id)).toEqual(['alpha', 'beta', 'beta-1', 'gamma']);
    });

    it('closes an expanded Project with hidden Sessions with its reveal row', () => {
        const rows = flattenPrimarySidebarRows(
            [{ id: 'alpha', hasHiddenSessions: true, sessionIds: ['alpha-1'] }],
            () => true,
        );
        expect(rows).toEqual([
            { id: 'alpha', kind: 'project', projectId: 'alpha' },
            { id: 'alpha-1', kind: 'session', projectId: 'alpha' },
            { id: primarySidebarRevealRowId('alpha'), kind: 'reveal', projectId: 'alpha' },
        ]);
    });

    it('leaves the reveal row out of a collapsed Project', () => {
        const rows = flattenPrimarySidebarRows(
            [{ id: 'alpha', hasHiddenSessions: true, sessionIds: ['alpha-1'] }],
            () => false,
        );
        expect(rows.map((row) => row.id)).toEqual(['alpha']);
    });
});

describe('nextPrimarySidebarRowId', () => {
    const rows = flattenPrimarySidebarRows(projects, () => true);

    it('moves Down and Up by one row', () => {
        expect(nextPrimarySidebarRowId(rows, 'alpha', 'ArrowDown')).toBe('alpha-1');
        expect(nextPrimarySidebarRowId(rows, 'alpha-1', 'ArrowUp')).toBe('alpha');
    });

    it('stops at either edge instead of wrapping', () => {
        expect(nextPrimarySidebarRowId(rows, 'alpha', 'ArrowUp')).toBeUndefined();
        expect(nextPrimarySidebarRowId(rows, 'gamma', 'ArrowDown')).toBeUndefined();
    });

    it('jumps to the first or last row on Home/End regardless of the current row', () => {
        expect(nextPrimarySidebarRowId(rows, 'beta-1', 'Home')).toBe('alpha');
        expect(nextPrimarySidebarRowId(rows, 'alpha-1', 'End')).toBe('gamma');
    });

    it('recovers to the first row when the active id no longer exists', () => {
        expect(nextPrimarySidebarRowId(rows, 'stale-id', 'ArrowDown')).toBe('alpha');
    });

    it('returns undefined for an empty tree', () => {
        expect(nextPrimarySidebarRowId([], undefined, 'ArrowDown')).toBeUndefined();
    });
});

describe('primarySidebarHorizontalIntent', () => {
    const projectRow = { id: 'alpha', kind: 'project' as const, projectId: 'alpha' };
    const sessionRow = { id: 'alpha-1', kind: 'session' as const, projectId: 'alpha' };

    it('opens a collapsed Project on Right and does nothing when already open', () => {
        expect(primarySidebarHorizontalIntent(projectRow, false, 'ArrowRight')).toEqual({
            expanded: true,
        });
        expect(primarySidebarHorizontalIntent(projectRow, true, 'ArrowRight')).toEqual({});
    });

    it('closes an open Project on Left and does nothing when already closed', () => {
        expect(primarySidebarHorizontalIntent(projectRow, true, 'ArrowLeft')).toEqual({
            expanded: false,
        });
        expect(primarySidebarHorizontalIntent(projectRow, false, 'ArrowLeft')).toEqual({});
    });

    it('moves a Session row to its owning Project on Left and is a no-op on Right', () => {
        expect(primarySidebarHorizontalIntent(sessionRow, true, 'ArrowLeft')).toEqual({
            focusRowId: 'alpha',
        });
        expect(primarySidebarHorizontalIntent(sessionRow, true, 'ArrowRight')).toEqual({});
    });

    it('treats a reveal row like a Session: Left goes to the Project, Right does nothing', () => {
        const revealRow = {
            id: primarySidebarRevealRowId('alpha'),
            kind: 'reveal' as const,
            projectId: 'alpha',
        };
        expect(primarySidebarHorizontalIntent(revealRow, true, 'ArrowLeft')).toEqual({
            focusRowId: 'alpha',
        });
        expect(primarySidebarHorizontalIntent(revealRow, true, 'ArrowRight')).toEqual({});
    });
});

describe('rovingPrimarySidebarRowId', () => {
    const rows = flattenPrimarySidebarRows(projects, () => true);

    it('prefers the last focused row when it is still present', () => {
        expect(rovingPrimarySidebarRowId(rows, 'beta-1', 'alpha-1', 'alpha')).toBe('beta-1');
    });

    it('falls back to the selected Session row when nothing has been focused yet', () => {
        expect(rovingPrimarySidebarRowId(rows, undefined, 'beta-1', 'alpha')).toBe('beta-1');
    });

    it('falls back to the selected Project heading when no Session is selected', () => {
        expect(rovingPrimarySidebarRowId(rows, undefined, undefined, 'beta')).toBe('beta');
    });

    it('falls back to the first row when nothing is focused or selected', () => {
        expect(rovingPrimarySidebarRowId(rows, undefined, undefined, undefined)).toBe('alpha');
    });

    it('falls through the same chain when the focused row no longer exists', () => {
        expect(rovingPrimarySidebarRowId(rows, 'stale-id', 'beta-1', 'alpha')).toBe('beta-1');
        expect(rovingPrimarySidebarRowId(rows, 'stale-id', undefined, 'beta')).toBe('beta');
        expect(rovingPrimarySidebarRowId(rows, 'stale-id', undefined, undefined)).toBe('alpha');
    });

    it('falls through when the selected Session row is hidden by a collapsed Project', () => {
        const collapsedRows = flattenPrimarySidebarRows(
            projects,
            (projectId) => projectId !== 'alpha',
        );
        expect(rovingPrimarySidebarRowId(collapsedRows, 'alpha-1', 'alpha-1', 'alpha')).toBe(
            'alpha',
        );
    });

    it('returns undefined for an empty tree', () => {
        expect(rovingPrimarySidebarRowId([], undefined, undefined, undefined)).toBeUndefined();
    });
});

describe('primarySidebarArchiveIntent', () => {
    const projectRow = { id: 'alpha', kind: 'project' as const, projectId: 'alpha' };
    const sessionRow = { id: 'alpha-1', kind: 'session' as const, projectId: 'alpha' };

    it('resolves Delete and Backspace on a Session row to archive', () => {
        expect(primarySidebarArchiveIntent(sessionRow, 'Delete')).toBe('archive');
        expect(primarySidebarArchiveIntent(sessionRow, 'Backspace')).toBe('archive');
    });

    it('is a no-op for any other key on a Session row', () => {
        expect(primarySidebarArchiveIntent(sessionRow, 'Enter')).toBeUndefined();
    });

    it('is always a no-op for a Project row', () => {
        expect(primarySidebarArchiveIntent(projectRow, 'Delete')).toBeUndefined();
        expect(primarySidebarArchiveIntent(projectRow, 'Backspace')).toBeUndefined();
    });

    it('is always a no-op for a reveal row', () => {
        const revealRow = {
            id: primarySidebarRevealRowId('alpha'),
            kind: 'reveal' as const,
            projectId: 'alpha',
        };
        expect(primarySidebarArchiveIntent(revealRow, 'Delete')).toBeUndefined();
    });
});
