import { describe, expect, it } from 'vitest';

import type { PrimarySidebarProjectNode } from '../primary-sidebar-tree';
import {
    flattenPrimarySidebarRows,
    nextPrimarySidebarRowId,
    PINNED_GROUP_ROW_ID,
    primarySidebarArchiveIntent,
    primarySidebarCreateSessionRowId,
    primarySidebarHorizontalIntent,
    primarySidebarPinnedRowId,
    primarySidebarRevealRowId,
    rovingPrimarySidebarRowId,
} from '../primary-sidebar-tree';

const projects: PrimarySidebarProjectNode[] = [
    { id: 'alpha', sessionIds: ['alpha-1', 'alpha-2'] },
    { id: 'beta', sessionIds: ['beta-1'] },
    { id: 'gamma', sessionIds: [] },
];

/**
 * `gamma` has no Sessions, so its "New Session" row stands in for them and is the tree's last row.
 */
const gammaCreateRowId = primarySidebarCreateSessionRowId('gamma');

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
            gammaCreateRowId,
        ]);
        expect(rows.find((row) => row.id === 'alpha-2')?.projectId).toBe('alpha');
    });

    it('skips a collapsed Project entirely so focus never lands on a hidden row', () => {
        const rows = flattenPrimarySidebarRows(projects, (projectId) => projectId !== 'alpha');
        expect(rows.map((row) => row.id)).toEqual([
            'alpha',
            'beta',
            'beta-1',
            'gamma',
            gammaCreateRowId,
        ]);
    });

    it('closes an expanded Project with hidden Sessions with its reveal row', () => {
        const rows = flattenPrimarySidebarRows(
            [{ id: 'alpha', hasHiddenSessions: true, sessionIds: ['alpha-1'] }],
            () => true,
        );
        expect(rows).toEqual([
            { id: 'alpha', kind: 'project', projectId: 'alpha' },
            { id: 'alpha-1', kind: 'session', projectId: 'alpha', sessionId: 'alpha-1' },
            { id: primarySidebarRevealRowId('alpha'), kind: 'reveal', projectId: 'alpha' },
        ]);
    });

    it('puts the Pinned group ahead of every Project, with namespaced row ids', () => {
        // Pinning moves a Session, so the caller hands the pinned ids to the Pinned group and withholds them from the
        // owning Project; `beta` is left with no Sessions of its own and falls back to its "New Session" row.
        const rows = flattenPrimarySidebarRows(
            [
                { id: 'alpha', sessionIds: ['alpha-1'] },
                { id: 'beta', sessionIds: [] },
            ],
            () => true,
            { expanded: true, sessionIds: ['beta-1', 'alpha-2'] },
        );
        expect(rows.map((row) => row.id)).toEqual([
            PINNED_GROUP_ROW_ID,
            primarySidebarPinnedRowId('beta-1'),
            primarySidebarPinnedRowId('alpha-2'),
            'alpha',
            'alpha-1',
            'beta',
            primarySidebarCreateSessionRowId('beta'),
        ]);
        // A pinned Session is reachable at exactly one row, under a Pinned-namespaced id no Project row can collide
        // with.
        expect(rows.filter((row) => row.sessionId === 'alpha-2').map((row) => row.id)).toEqual([
            primarySidebarPinnedRowId('alpha-2'),
        ]);
    });

    it('renders no Pinned group at all when nothing is pinned', () => {
        const rows = flattenPrimarySidebarRows(projects, () => true, {
            expanded: true,
            sessionIds: [],
        });
        expect(rows.some((row) => row.projectId === PINNED_GROUP_ROW_ID)).toBe(false);
    });

    it('closes an over-full Pinned group with its own reveal row', () => {
        const rows = flattenPrimarySidebarRows(projects, () => true, {
            expanded: true,
            hasHiddenSessions: true,
            sessionIds: ['beta-1'],
        });
        expect(rows.filter((row) => row.projectId === PINNED_GROUP_ROW_ID).map((row) => row.id)) //
            .toEqual([
                PINNED_GROUP_ROW_ID,
                primarySidebarPinnedRowId('beta-1'),
                primarySidebarRevealRowId(PINNED_GROUP_ROW_ID),
            ]);
    });

    it('leaves the Pinned reveal row out while the group is collapsed', () => {
        const rows = flattenPrimarySidebarRows(projects, () => true, {
            expanded: false,
            hasHiddenSessions: true,
            sessionIds: ['beta-1'],
        });
        expect(rows.some((row) => row.kind === 'reveal')).toBe(false);
    });

    it('keeps the Pinned heading but drops its rows while it is collapsed', () => {
        const rows = flattenPrimarySidebarRows(projects, () => true, {
            expanded: false,
            sessionIds: ['beta-1'],
        });
        expect(rows.filter((row) => row.projectId === PINNED_GROUP_ROW_ID).map((row) => row.id)) //
            .toEqual([PINNED_GROUP_ROW_ID]);
    });

    it('leaves the reveal row out of a collapsed Project', () => {
        const rows = flattenPrimarySidebarRows(
            [{ id: 'alpha', hasHiddenSessions: true, sessionIds: ['alpha-1'] }],
            () => false,
        );
        expect(rows.map((row) => row.id)).toEqual(['alpha']);
    });

    /**
     * The "New Session" row is the only row an empty Project has below its heading, so leaving it out of the tree is
     * what used to make arrow keys skip straight past it (github.com/tjx666/caxri/issues/608).
     */
    it('stands the New Session row in for an expanded Project with no Sessions', () => {
        const rows = flattenPrimarySidebarRows([{ id: 'gamma', sessionIds: [] }], () => true);
        expect(rows).toEqual([
            { id: 'gamma', kind: 'project', projectId: 'gamma' },
            { id: gammaCreateRowId, kind: 'createSession', projectId: 'gamma' },
        ]);
    });

    it('leaves the New Session row out of a collapsed Project', () => {
        const rows = flattenPrimarySidebarRows([{ id: 'gamma', sessionIds: [] }], () => false);
        expect(rows.map((row) => row.id)).toEqual(['gamma']);
    });
});

describe('primarySidebarCreateSessionRowId', () => {
    it('namespaces the row id so it can never collide with a Session or reveal row', () => {
        expect(gammaCreateRowId).not.toBe('gamma');
        expect(gammaCreateRowId).not.toBe(primarySidebarRevealRowId('gamma'));
        expect(gammaCreateRowId).not.toBe(primarySidebarPinnedRowId('gamma'));
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
        expect(nextPrimarySidebarRowId(rows, gammaCreateRowId, 'ArrowDown')).toBeUndefined();
    });

    it('walks Down onto an empty Project New Session row and back up to its heading', () => {
        expect(nextPrimarySidebarRowId(rows, 'gamma', 'ArrowDown')).toBe(gammaCreateRowId);
        expect(nextPrimarySidebarRowId(rows, gammaCreateRowId, 'ArrowUp')).toBe('gamma');
    });

    it('jumps to the first or last row on Home/End regardless of the current row', () => {
        expect(nextPrimarySidebarRowId(rows, 'beta-1', 'Home')).toBe('alpha');
        expect(nextPrimarySidebarRowId(rows, 'alpha-1', 'End')).toBe(gammaCreateRowId);
    });

    it('recovers to the first row when the active id no longer exists', () => {
        expect(nextPrimarySidebarRowId(rows, 'stale-id', 'ArrowDown')).toBe('alpha');
    });

    it('returns undefined for an empty tree', () => {
        expect(nextPrimarySidebarRowId([], undefined, 'ArrowDown')).toBeUndefined();
    });
});

describe('primarySidebarHorizontalIntent', () => {
    const expandedRows = flattenPrimarySidebarRows(projects, () => true);
    const collapsedRows = flattenPrimarySidebarRows(projects, () => false);
    const projectRow = { id: 'alpha', kind: 'project' as const, projectId: 'alpha' };
    const sessionRow = { id: 'alpha-1', kind: 'session' as const, projectId: 'alpha' };

    it('opens a collapsed Project on Right', () => {
        expect(
            primarySidebarHorizontalIntent(collapsedRows, projectRow, false, 'ArrowRight'),
        ).toEqual({ expanded: true });
    });

    /**
     * The second Right press is what used to do nothing at all, leaving Down as the only way into a Project the user
     * had just opened with the keyboard.
     */
    it('steps into the first Session of an already open Project on Right', () => {
        expect(
            primarySidebarHorizontalIntent(expandedRows, projectRow, true, 'ArrowRight'),
        ).toEqual({ focusRowId: 'alpha-1' });
    });

    it('steps into the New Session row of an open Project that has no Sessions', () => {
        const gammaRow = { id: 'gamma', kind: 'project' as const, projectId: 'gamma' };
        expect(primarySidebarHorizontalIntent(expandedRows, gammaRow, true, 'ArrowRight')).toEqual({
            focusRowId: gammaCreateRowId,
        });
    });

    it('does nothing on Right when an open Project renders no rows below its heading', () => {
        const rows = flattenPrimarySidebarRows([{ id: 'alpha', sessionIds: [] }], () => false);
        expect(primarySidebarHorizontalIntent(rows, projectRow, true, 'ArrowRight')).toEqual({});
    });

    it('closes an open Project on Left and does nothing when already closed', () => {
        expect(primarySidebarHorizontalIntent(expandedRows, projectRow, true, 'ArrowLeft')).toEqual(
            { expanded: false },
        );
        expect(
            primarySidebarHorizontalIntent(collapsedRows, projectRow, false, 'ArrowLeft'),
        ).toEqual({});
    });

    it('moves a Session row to its owning Project on Left and is a no-op on Right', () => {
        expect(primarySidebarHorizontalIntent(expandedRows, sessionRow, true, 'ArrowLeft')).toEqual(
            { focusRowId: 'alpha' },
        );
        expect(
            primarySidebarHorizontalIntent(expandedRows, sessionRow, true, 'ArrowRight'),
        ).toEqual({});
    });

    it('treats a reveal row like a Session: Left goes to the Project, Right does nothing', () => {
        const revealRow = {
            id: primarySidebarRevealRowId('alpha'),
            kind: 'reveal' as const,
            projectId: 'alpha',
        };
        expect(primarySidebarHorizontalIntent(expandedRows, revealRow, true, 'ArrowLeft')).toEqual({
            focusRowId: 'alpha',
        });
        expect(primarySidebarHorizontalIntent(expandedRows, revealRow, true, 'ArrowRight')).toEqual(
            {},
        );
    });

    it('treats a New Session row like a Session: Left goes to the Project, Right does nothing', () => {
        const createRow = {
            id: gammaCreateRowId,
            kind: 'createSession' as const,
            projectId: 'gamma',
        };
        expect(primarySidebarHorizontalIntent(expandedRows, createRow, true, 'ArrowLeft')).toEqual({
            focusRowId: 'gamma',
        });
        expect(primarySidebarHorizontalIntent(expandedRows, createRow, true, 'ArrowRight')).toEqual(
            {},
        );
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

    it('reaches the selected Session in the Pinned group when its Project is collapsed', () => {
        const collapsedRows = flattenPrimarySidebarRows(
            projects,
            (projectId) => projectId !== 'alpha',
            { expanded: true, sessionIds: ['alpha-1'] },
        );
        expect(rovingPrimarySidebarRowId(collapsedRows, undefined, 'alpha-1', 'alpha')).toBe(
            primarySidebarPinnedRowId('alpha-1'),
        );
    });

    it('still prefers the Project group row when both copies are on screen', () => {
        const rows = flattenPrimarySidebarRows(projects, () => true, {
            expanded: true,
            sessionIds: ['alpha-1'],
        });
        expect(rovingPrimarySidebarRowId(rows, undefined, 'alpha-1', 'alpha')).toBe('alpha-1');
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

    it('is always a no-op for a New Session row', () => {
        const createRow = {
            id: gammaCreateRowId,
            kind: 'createSession' as const,
            projectId: 'gamma',
        };
        expect(primarySidebarArchiveIntent(createRow, 'Delete')).toBeUndefined();
        expect(primarySidebarArchiveIntent(createRow, 'Backspace')).toBeUndefined();
    });
});
