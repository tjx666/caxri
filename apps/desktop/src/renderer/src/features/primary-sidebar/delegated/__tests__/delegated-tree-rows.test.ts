import { describe, expect, it } from 'vitest';

import type {
    PrimarySidebarDelegatedNode,
    PrimarySidebarSubagentNode,
    PrimarySidebarTreeRow,
} from '../../primary-sidebar-tree';
import {
    flattenPrimarySidebarRows,
    nextPrimarySidebarRowId,
    PINNED_GROUP_ROW_ID,
    primarySidebarArchiveIntent,
    primarySidebarDelegatedRevealRowId,
    primarySidebarDelegatedRowId,
    primarySidebarHorizontalIntent,
    primarySidebarPinnedRowId,
    primarySidebarSubagentRowId,
    rovingPrimarySidebarRowId,
} from '../../primary-sidebar-tree';

const projects = [
    { id: 'alpha', sessionIds: ['host', 'plain'] },
    { id: 'beta', sessionIds: ['beta-1'] },
];

const delegated = new Map<string, PrimarySidebarDelegatedNode>([
    ['host', { hasHiddenSessions: true, sessionIds: ['child-1', 'child-2'] }],
]);

function rowIds(rows: readonly PrimarySidebarTreeRow[]): string[] {
    return rows.map((row) => row.id);
}

function rowById(rows: readonly PrimarySidebarTreeRow[], id: string): PrimarySidebarTreeRow {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`expected row ${id}`);
    return row;
}

describe('delegated rows in flattenPrimarySidebarRows', () => {
    it('lists nested Sessions and the reveal row right after their host', () => {
        const rows = flattenPrimarySidebarRows(
            projects,
            () => true,
            undefined,
            undefined,
            delegated,
        );
        expect(rowIds(rows)).toEqual([
            'alpha',
            'host',
            primarySidebarDelegatedRowId('child-1'),
            primarySidebarDelegatedRowId('child-2'),
            primarySidebarDelegatedRevealRowId('host'),
            'plain',
            'beta',
            'beta-1',
        ]);
        expect(rowById(rows, primarySidebarDelegatedRowId('child-1'))).toEqual({
            id: 'delegated-session:child-1',
            kind: 'delegatedSession',
            parentRowId: 'host',
            projectId: 'alpha',
            sessionId: 'child-1',
        });
        // The reveal row acts on the host: it owns the window the reveal widens.
        expect(rowById(rows, 'reveal-delegated:host')).toEqual({
            id: 'reveal-delegated:host',
            kind: 'delegatedReveal',
            parentRowId: 'host',
            projectId: 'alpha',
            sessionId: 'host',
        });
    });

    it('leaves the reveal row out when the child window hides nothing', () => {
        const rows = flattenPrimarySidebarRows(
            projects,
            () => true,
            undefined,
            undefined,
            new Map([['host', { sessionIds: ['child-1'] }]]),
        );
        expect(rows.some((row) => row.kind === 'delegatedReveal')).toBe(false);
    });

    it('leaves nested rows out of a collapsed Project and when none are given', () => {
        expect(
            flattenPrimarySidebarRows(projects, () => false, undefined, undefined, delegated).some(
                (row) => row.kind === 'delegatedSession' || row.kind === 'delegatedReveal',
            ),
        ).toBe(false);
        expect(
            flattenPrimarySidebarRows(projects, () => true).some(
                (row) => row.kind === 'delegatedSession',
            ),
        ).toBe(false);
    });

    it('puts nested rows after the host subagent rows', () => {
        const subagents = new Map<string, PrimarySidebarSubagentNode>([
            ['host', { taskIds: ['t1'], terminalId: 'chat-1' }],
        ]);
        const rows = flattenPrimarySidebarRows(
            projects,
            () => true,
            undefined,
            subagents,
            delegated,
        );
        expect(rowIds(rows).slice(0, 6)).toEqual([
            'alpha',
            'host',
            primarySidebarSubagentRowId('host', 't1'),
            primarySidebarDelegatedRowId('child-1'),
            primarySidebarDelegatedRowId('child-2'),
            primarySidebarDelegatedRevealRowId('host'),
        ]);
    });

    it('nests under a pinned host row with its namespaced id, in the Pinned group', () => {
        const rows = flattenPrimarySidebarRows(
            [{ id: 'beta', sessionIds: ['beta-1'] }],
            () => true,
            { expanded: true, sessionIds: ['host'] },
            undefined,
            delegated,
        );
        expect(rowIds(rows).slice(0, 5)).toEqual([
            PINNED_GROUP_ROW_ID,
            primarySidebarPinnedRowId('host'),
            primarySidebarDelegatedRowId('child-1'),
            primarySidebarDelegatedRowId('child-2'),
            primarySidebarDelegatedRevealRowId('host'),
        ]);
        expect(rowById(rows, primarySidebarDelegatedRowId('child-1'))).toMatchObject({
            parentRowId: primarySidebarPinnedRowId('host'),
            projectId: PINNED_GROUP_ROW_ID,
        });
    });

    it('keeps nested rows out of a collapsed Pinned group', () => {
        const rows = flattenPrimarySidebarRows(
            [],
            () => true,
            { expanded: false, sessionIds: ['host'] },
            undefined,
            delegated,
        );
        expect(rowIds(rows)).toEqual([PINNED_GROUP_ROW_ID]);
    });
});

describe('delegated row keyboard semantics', () => {
    const rows = flattenPrimarySidebarRows(projects, () => true, undefined, undefined, delegated);
    const childRowId = primarySidebarDelegatedRowId('child-1');

    it('moves Down and Up through nested rows one at a time', () => {
        expect(nextPrimarySidebarRowId(rows, 'host', 'ArrowDown')).toBe(childRowId);
        expect(nextPrimarySidebarRowId(rows, childRowId, 'ArrowUp')).toBe('host');
        expect(
            nextPrimarySidebarRowId(rows, primarySidebarDelegatedRevealRowId('host'), 'ArrowDown'),
        ).toBe('plain');
    });

    it('sends Left from a nested or reveal row to the host row, never to the Project', () => {
        for (const id of [childRowId, primarySidebarDelegatedRevealRowId('host')])
            expect(
                primarySidebarHorizontalIntent(rows, rowById(rows, id), true, 'ArrowLeft'),
            ).toEqual({ focusRowId: 'host' });
    });

    it('sends Right from the host to its first nested row', () => {
        expect(
            primarySidebarHorizontalIntent(rows, rowById(rows, 'host'), true, 'ArrowRight'),
        ).toEqual({
            focusRowId: childRowId,
        });
    });

    it('sends Right from a host with subagents to its first subagent, then Down reaches the nested rows', () => {
        const withSubagents = flattenPrimarySidebarRows(
            projects,
            () => true,
            undefined,
            new Map([['host', { taskIds: ['t1'], terminalId: 'chat-1' }]]),
            delegated,
        );
        const subagentRowId = primarySidebarSubagentRowId('host', 't1');
        expect(
            primarySidebarHorizontalIntent(
                withSubagents,
                rowById(withSubagents, 'host'),
                true,
                'ArrowRight',
            ),
        ).toEqual({ focusRowId: subagentRowId });
        expect(nextPrimarySidebarRowId(withSubagents, subagentRowId, 'ArrowDown')).toBe(childRowId);
        // Left from a nested row still returns to the host, past the subagent rows above it.
        expect(
            primarySidebarHorizontalIntent(
                withSubagents,
                rowById(withSubagents, childRowId),
                true,
                'ArrowLeft',
            ),
        ).toEqual({ focusRowId: 'host' });
    });

    it('does nothing on Right for a nested row, a reveal row, or a host with no children', () => {
        for (const id of [childRowId, primarySidebarDelegatedRevealRowId('host'), 'plain'])
            expect(
                primarySidebarHorizontalIntent(rows, rowById(rows, id), true, 'ArrowRight'),
            ).toEqual({});
    });

    it('steps Right from a pinned host into its first nested row', () => {
        const pinnedRows = flattenPrimarySidebarRows(
            [],
            () => true,
            { expanded: true, sessionIds: ['host'] },
            undefined,
            delegated,
        );
        const pinnedHost = rowById(pinnedRows, primarySidebarPinnedRowId('host'));
        expect(primarySidebarHorizontalIntent(pinnedRows, pinnedHost, true, 'ArrowRight')).toEqual({
            focusRowId: childRowId,
        });
        expect(
            primarySidebarHorizontalIntent(
                pinnedRows,
                rowById(pinnedRows, childRowId),
                true,
                'ArrowLeft',
            ),
        ).toEqual({ focusRowId: primarySidebarPinnedRowId('host') });
    });

    it('archives from a nested row but not from its reveal row', () => {
        expect(primarySidebarArchiveIntent(rowById(rows, childRowId), 'Delete')).toBe('archive');
        expect(primarySidebarArchiveIntent(rowById(rows, childRowId), 'Backspace')).toBe('archive');
        expect(primarySidebarArchiveIntent(rowById(rows, childRowId), 'Enter')).toBeUndefined();
        const revealRow = rowById(rows, primarySidebarDelegatedRevealRowId('host'));
        expect(primarySidebarArchiveIntent(revealRow, 'Delete')).toBeUndefined();
    });
});

describe('roving focus onto delegated rows', () => {
    const rows = flattenPrimarySidebarRows(projects, () => true, undefined, undefined, delegated);

    it('rests on the selected nested Session row', () => {
        expect(rovingPrimarySidebarRowId(rows, undefined, 'child-2', 'beta')).toBe(
            primarySidebarDelegatedRowId('child-2'),
        );
    });

    it('prefers the focused row while it exists', () => {
        expect(rovingPrimarySidebarRowId(rows, 'plain', 'child-2', 'beta')).toBe('plain');
    });

    it('falls back to the host row, then the host group, for a selected Session with no row', () => {
        // The host window folded the selected Session away (or it is a hidden consult): no row of its own.
        expect(
            rovingPrimarySidebarRowId(rows, undefined, 'child-9', 'beta', ['host', 'alpha']),
        ).toBe('host');
        const collapsed = flattenPrimarySidebarRows(
            projects,
            (projectId) => projectId !== 'alpha',
            undefined,
            undefined,
            delegated,
        );
        expect(
            rovingPrimarySidebarRowId(collapsed, undefined, 'child-1', 'beta', ['host', 'alpha']),
        ).toBe('alpha');
    });

    it('keeps the host group ahead of the selected Project heading', () => {
        // The selected Session's own Project is `beta`, but it lives under a host in `alpha`.
        const collapsed = flattenPrimarySidebarRows(
            projects,
            (projectId) => projectId !== 'alpha',
            undefined,
            undefined,
            delegated,
        );
        expect(
            rovingPrimarySidebarRowId(collapsed, undefined, 'child-1', 'beta', ['host', 'alpha']),
        ).toBe('alpha');
        // Without a fallback it would have landed on the unrelated Project.
        expect(rovingPrimarySidebarRowId(collapsed, undefined, 'child-1', 'beta')).toBe('beta');
    });

    it('uses the pinned host row as the fallback when the Pinned group lists the host', () => {
        const pinnedRows = flattenPrimarySidebarRows(
            [{ id: 'beta', sessionIds: ['beta-1'] }],
            () => true,
            { expanded: true, sessionIds: ['host'] },
            undefined,
            new Map([['host', { sessionIds: [] }]]),
        );
        expect(
            rovingPrimarySidebarRowId(pinnedRows, undefined, 'consult', 'beta', [
                primarySidebarPinnedRowId('host'),
                PINNED_GROUP_ROW_ID,
            ]),
        ).toBe(primarySidebarPinnedRowId('host'));
    });
});
