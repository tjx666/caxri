import { describe, expect, it } from 'vitest';

import { PINNED_GROUP_ROW_ID } from '../../primary-sidebar-tree';
import {
    nestedHostId,
    nestedSessions,
    placeDelegatedSessions,
    selectedHostFallbackRowIds,
    sessionRevealTarget,
} from '../delegated-placement';
import { createdBy, project, session } from './delegated-sessions.fixture';

const projects = [project('alpha', 0), project('beta', 1)];

function place(
    sessions: Parameters<typeof placeDelegatedSessions>[0]['sessions'],
    selectedSessionId?: string,
    listed = projects,
) {
    return placeDelegatedSessions({ projects: listed, selectedSessionId, sessions });
}

function ids(sessions: ReadonlyArray<{ id: string }> | undefined): string[] {
    return (sessions ?? []).map(({ id }) => id);
}

function sortedIds(sessions: ReadonlyArray<{ id: string }> | undefined): string[] {
    return ids(sessions).toSorted((left, right) => left.localeCompare(right));
}

describe('placeDelegatedSessions', () => {
    it('keeps Sessions with no creator, and handoff Sessions, as ordinary rows', () => {
        const placement = place([
            session('plain', 'alpha'),
            session('source', 'alpha'),
            createdBy('handoff', 'alpha', 'source', 'handoff'),
            // The read model drops the creator of a deleted Session; a relation without one is an ordinary row.
            session('orphan', 'alpha', { createdByRelation: 'delegated' }),
        ]);
        expect(ids(placement.rows)).toEqual(['plain', 'source', 'handoff', 'orphan']);
        expect(placement.nestedByHost.size).toBe(0);
        expect(placement.hiddenByHost.size).toBe(0);
    });

    it('gives an independent Session its own row, in its own Project, beside its creator', () => {
        const placement = place([
            session('creator', 'alpha'),
            createdBy('sibling', 'beta', 'creator', 'independent'),
            createdBy('child', 'alpha', 'sibling', 'delegated'),
        ]);
        expect(placement.byId.get('sibling')).toEqual({ kind: 'row' });
        expect(ids(placement.rows)).toEqual(['creator', 'sibling']);
        // It starts a new nesting level, like a hand-off: what it delegates nests under it, not under its creator.
        expect(placement.byId.get('child')).toEqual({ hostId: 'sibling', kind: 'nested' });
        expect(placement.nestedByHost.has('creator')).toBe(false);
    });

    it('nests a delegated Session under its creator, whatever Project it lives in', () => {
        const placement = place([
            session('host', 'alpha'),
            createdBy('child', 'beta', 'host', 'delegated'),
        ]);
        expect(placement.byId.get('child')).toEqual({ hostId: 'host', kind: 'nested' });
        expect(ids(placement.rows)).toEqual(['host']);
        expect(ids(placement.nestedByHost.get('host'))).toEqual(['child']);
        expect(nestedHostId(placement, 'child')).toBe('host');
        expect(nestedHostId(placement, 'host')).toBeUndefined();
    });

    it('flattens a delegation chain onto the first listed ancestor', () => {
        const placement = place([
            session('root', 'alpha'),
            createdBy('middle', 'alpha', 'root', 'delegated'),
            createdBy('leaf', 'alpha', 'middle', 'delegated', { sidebarOrder: 1 }),
        ]);
        expect(placement.byId.get('leaf')).toEqual({ hostId: 'root', kind: 'nested' });
        expect(ids(placement.nestedByHost.get('root'))).toEqual(['middle', 'leaf']);
        expect(placement.nestedByHost.has('middle')).toBe(false);
    });

    it('starts a new nesting level at a handoff Session, which keeps its own row', () => {
        const placement = place([
            session('root', 'alpha'),
            createdBy('handoff', 'alpha', 'root', 'handoff'),
            createdBy('child', 'alpha', 'handoff', 'delegated'),
        ]);
        expect(ids(placement.rows)).toEqual(['root', 'handoff']);
        expect(placement.byId.get('child')).toEqual({ hostId: 'handoff', kind: 'nested' });
    });

    it('hides a consult under its listed creator and keeps it out of the rows', () => {
        const placement = place([
            session('host', 'alpha'),
            createdBy('consult', 'alpha', 'host', 'consult'),
        ]);
        expect(placement.byId.get('consult')).toEqual({ hostId: 'host', kind: 'hidden' });
        expect(ids(placement.rows)).toEqual(['host']);
        expect(ids(placement.hiddenByHost.get('host'))).toEqual(['consult']);
        expect(nestedSessions(placement)).toEqual([]);
    });

    it('hides a consult created by a consult or a delegated Session under the chain host', () => {
        const placement = place([
            session('root', 'alpha'),
            createdBy('first', 'alpha', 'root', 'consult'),
            createdBy('second', 'alpha', 'first', 'consult'),
            createdBy('worker', 'alpha', 'root', 'delegated'),
            createdBy('worker-consult', 'alpha', 'worker', 'consult'),
        ]);
        expect(sortedIds(placement.hiddenByHost.get('root'))).toEqual([
            'first',
            'second',
            'worker-consult',
        ]);
        expect(ids(placement.nestedByHost.get('root'))).toEqual(['worker']);
    });

    it('nests what a hidden consult delegated under the consult host', () => {
        const placement = place([
            session('root', 'alpha'),
            createdBy('consult', 'alpha', 'root', 'consult'),
            createdBy('child', 'alpha', 'consult', 'delegated'),
        ]);
        expect(placement.byId.get('child')).toEqual({ hostId: 'root', kind: 'nested' });
    });

    it('shows the selected hidden consult nested so the selection stays visible', () => {
        const sessions = [
            session('host', 'alpha'),
            createdBy('consult', 'alpha', 'host', 'consult'),
            createdBy('other', 'alpha', 'host', 'consult'),
        ];
        const placement = place(sessions, 'consult');
        expect(placement.byId.get('consult')).toEqual({ hostId: 'host', kind: 'nested' });
        expect(placement.byId.get('other')).toEqual({ hostId: 'host', kind: 'hidden' });
        expect(nestedHostId(placement, 'consult')).toBe('host');
        // Deselected, it hides again.
        expect(place(sessions).byId.get('consult')).toEqual({ hostId: 'host', kind: 'hidden' });
    });

    it('returns what an archived creator made to ordinary rows', () => {
        const placement = place([
            session('root', 'alpha'),
            createdBy('archived-middle', 'alpha', 'root', 'delegated', { archivedAt: 5 }),
            createdBy('orphan', 'alpha', 'archived-middle', 'delegated'),
            createdBy('orphan-consult', 'alpha', 'archived-middle', 'consult'),
        ]);
        expect(placement.byId.has('archived-middle')).toBe(false);
        expect(placement.byId.get('orphan')).toEqual({ kind: 'row' });
        expect(placement.byId.get('orphan-consult')).toEqual({ kind: 'row' });
    });

    it('treats a creator that is missing from the records like a deleted one', () => {
        const placement = place([createdBy('lost', 'alpha', 'gone', 'delegated')]);
        expect(placement.byId.get('lost')).toEqual({ kind: 'row' });
    });

    it('leaves a creator cycle as ordinary rows so no row disappears', () => {
        const placement = place([
            createdBy('a', 'alpha', 'b', 'delegated'),
            createdBy('b', 'alpha', 'a', 'delegated'),
            createdBy('self', 'alpha', 'self', 'delegated'),
        ]);
        expect(ids(placement.rows)).toEqual(['a', 'b', 'self']);
    });

    it('stops following a chain past the depth cap and leaves the Session ordinary', () => {
        const chain = [session('s0', 'alpha')];
        for (let index = 1; index <= 20; index += 1)
            chain.push(createdBy(`s${index}`, 'alpha', `s${index - 1}`, 'delegated'));
        const placement = place(chain);
        expect(placement.byId.get('s16')).toEqual({ hostId: 's0', kind: 'nested' });
        expect(placement.byId.get('s17')).toEqual({ kind: 'row' });
        expect(placement.byId.get('s20')).toEqual({ kind: 'row' });
    });

    it('does not list a Session of an unlisted Project, or let it host', () => {
        const placement = place(
            [
                session('hidden-host', 'worktree'),
                createdBy('child', 'alpha', 'hidden-host', 'delegated'),
                createdBy('consult', 'alpha', 'hidden-host', 'consult'),
            ],
            undefined,
            [project('alpha', 0)],
        );
        expect(placement.byId.has('hidden-host')).toBe(false);
        expect(placement.byId.get('child')).toEqual({ kind: 'row' });
        expect(placement.byId.get('consult')).toEqual({ kind: 'row' });
    });

    describe('taken-over Sessions', () => {
        const sessions = [
            session('host', 'alpha'),
            createdBy('taken', 'beta', 'host', 'delegated'),
            createdBy('grandchild', 'alpha', 'taken', 'delegated'),
            createdBy('sibling', 'alpha', 'host', 'delegated', { sidebarOrder: 1 }),
        ];

        it('gives a delegated Session the user controls an ordinary row in its own Project', () => {
            const placement = placeDelegatedSessions({
                humanControlledSessionIds: new Set(['taken']),
                projects,
                selectedSessionId: undefined,
                sessions,
            });
            expect(placement.byId.get('taken')).toEqual({ kind: 'row' });
            expect(ids(placement.rows)).toEqual(['host', 'taken']);
            expect(ids(placement.nestedByHost.get('host'))).toEqual(['sibling']);
            // It hosts what it delegated, like any other row.
            expect(placement.byId.get('grandchild')).toEqual({ hostId: 'taken', kind: 'nested' });
        });

        it('nests it again once the user hands it back', () => {
            const placement = place(sessions);
            expect(placement.byId.get('taken')).toEqual({ hostId: 'host', kind: 'nested' });
            expect(placement.byId.get('grandchild')).toEqual({ hostId: 'host', kind: 'nested' });
        });

        it('leaves a consult hidden even when the feed names it', () => {
            const placement = placeDelegatedSessions({
                humanControlledSessionIds: new Set(['asked']),
                projects,
                selectedSessionId: undefined,
                sessions: [
                    session('host', 'alpha'),
                    createdBy('asked', 'alpha', 'host', 'consult'),
                ],
            });
            expect(placement.byId.get('asked')).toEqual({ hostId: 'host', kind: 'hidden' });
        });
    });

    describe('pinned Sessions', () => {
        it('keeps a pinned delegated Session as a flat row instead of nesting it', () => {
            const placement = place([
                session('host', 'alpha'),
                createdBy('pinned-child', 'alpha', 'host', 'delegated', { pinnedAt: 10 }),
            ]);
            expect(placement.byId.get('pinned-child')).toEqual({ kind: 'row' });
            expect(ids(placement.rows)).toEqual(['host', 'pinned-child']);
        });

        it('lets a pinned Session host, and counts what it hosts for the Pinned group', () => {
            const placement = place([
                session('host', 'alpha', { pinnedAt: 10 }),
                createdBy('child', 'beta', 'host', 'delegated'),
                createdBy('consult', 'beta', 'host', 'consult'),
            ]);
            expect(placement.groupIdBySessionId.get('child')).toBe(PINNED_GROUP_ROW_ID);
            expect(placement.groupIdBySessionId.get('consult')).toBe(PINNED_GROUP_ROW_ID);
            expect(sortedIds(placement.hostedByGroup.get(PINNED_GROUP_ROW_ID))).toEqual([
                'child',
                'consult',
            ]);
            expect(placement.hostedByGroup.has('alpha')).toBe(false);
        });

        it('lets a pinned Session in an unlisted Project host, because the Pinned group lists it', () => {
            const placement = place(
                [
                    session('host', 'worktree', { pinnedAt: 10 }),
                    createdBy('child', 'alpha', 'host', 'delegated'),
                ],
                undefined,
                [project('alpha', 0)],
            );
            expect(placement.byId.get('host')).toEqual({ kind: 'row' });
            expect(placement.byId.get('child')).toEqual({ hostId: 'host', kind: 'nested' });
        });

        it('hides a pinned consult before pin placement, so it never reaches the Pinned group', () => {
            const placement = place([
                session('host', 'alpha'),
                createdBy('pinned-consult', 'alpha', 'host', 'consult', { pinnedAt: 10 }),
            ]);
            expect(placement.byId.get('pinned-consult')).toEqual({
                hostId: 'host',
                kind: 'hidden',
            });
            expect(ids(placement.rows)).toEqual(['host']);
        });

        it('nests a pinned consult when it is the selected Session', () => {
            const placement = place(
                [
                    session('host', 'alpha'),
                    createdBy('pinned-consult', 'alpha', 'host', 'consult', { pinnedAt: 10 }),
                ],
                'pinned-consult',
            );
            expect(placement.byId.get('pinned-consult')).toEqual({
                hostId: 'host',
                kind: 'nested',
            });
            expect(ids(placement.rows)).toEqual(['host']);
        });
    });

    describe('group attribution', () => {
        it('attributes nested and hidden Sessions to their host Project, never rewriting projectId', () => {
            const child = createdBy('child', 'beta', 'host', 'delegated');
            const placement = place([
                session('host', 'alpha'),
                child,
                createdBy('consult', 'beta', 'host', 'consult'),
                session('plain', 'beta'),
            ]);
            expect(placement.groupIdBySessionId.get('child')).toBe('alpha');
            expect(placement.groupIdBySessionId.get('consult')).toBe('alpha');
            expect(placement.groupIdBySessionId.has('plain')).toBe(false);
            expect(sortedIds(placement.hostedByGroup.get('alpha'))).toEqual(['child', 'consult']);
            expect(placement.hostedByGroup.has('beta')).toBe(false);
            expect(child.projectId).toBe('beta');
        });
    });
});

describe('sessionRevealTarget', () => {
    const sessions = [
        session('host', 'alpha'),
        session('pinned', 'beta', { pinnedAt: 5 }),
        createdBy('child', 'beta', 'host', 'delegated'),
        createdBy('consult', 'beta', 'host', 'consult'),
        createdBy('pinned-child', 'alpha', 'pinned', 'delegated'),
        session('plain', 'beta'),
    ];
    const placement = place(sessions);
    const byId = new Map(sessions.map((entry) => [entry.id, entry]));
    const target = (id: string) => sessionRevealTarget(placement, byId.get(id)!);

    it('opens the Project of an ordinary row and the Pinned group for a pinned one', () => {
        expect(target('plain')).toEqual({ groupId: 'beta', rowId: 'plain' });
        expect(target('pinned')).toEqual({
            groupId: PINNED_GROUP_ROW_ID,
            rowId: 'pinned-session:pinned',
        });
    });

    it('opens the host group, not the Project, of a nested Session', () => {
        expect(target('child')).toEqual({ groupId: 'alpha', rowId: 'delegated-session:child' });
        expect(target('pinned-child')).toEqual({
            groupId: PINNED_GROUP_ROW_ID,
            rowId: 'delegated-session:pinned-child',
        });
    });

    it('points a hidden consult at its host row, the nearest place it lives', () => {
        expect(target('consult')).toEqual({ groupId: 'alpha', rowId: 'host' });
    });
});

describe('selectedHostFallbackRowIds', () => {
    const placement = place([
        session('host', 'alpha'),
        session('pinned-host', 'beta', { pinnedAt: 5 }),
        createdBy('child', 'beta', 'host', 'delegated'),
        createdBy('pinned-hosted', 'alpha', 'pinned-host', 'delegated'),
    ]);

    it('falls back to the host row and then the host group for a nested Session', () => {
        expect(selectedHostFallbackRowIds(placement, 'child')).toEqual(['host', 'alpha']);
        expect(selectedHostFallbackRowIds(placement, 'pinned-hosted')).toEqual([
            'pinned-session:pinned-host',
            PINNED_GROUP_ROW_ID,
        ]);
    });

    it('has no fallback of its own for ordinary rows and unknown selections', () => {
        expect(selectedHostFallbackRowIds(placement, 'host')).toEqual([]);
        expect(selectedHostFallbackRowIds(placement, 'missing')).toEqual([]);
        expect(selectedHostFallbackRowIds(placement, undefined)).toEqual([]);
    });
});
