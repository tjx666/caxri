import { describe, expect, it } from 'vitest';

import {
    firstSessionOfProject,
    placedPinnedSessions,
    rowSessionsByProject,
    sidebarSessionOrder,
} from '../delegated-order';
import { placeDelegatedSessions } from '../delegated-placement';
import { createdBy, project, session } from './delegated-sessions.fixture';

const projects = [project('alpha', 0), project('beta', 1)];

function ids(sessions: ReadonlyArray<{ id: string }>): string[] {
    return sessions.map(({ id }) => id);
}

describe('rowSessionsByProject', () => {
    it('follows Project order and sorts Sessions by sidebar order inside a Project', () => {
        const placement = placeDelegatedSessions({
            projects,
            selectedSessionId: undefined,
            sessions: [
                session('b-late', 'beta', { sidebarOrder: 2 }),
                session('a-late', 'alpha', { sidebarOrder: 2 }),
                session('b-early', 'beta', { sidebarOrder: 1 }),
                session('a-early', 'alpha', { sidebarOrder: 1 }),
            ],
        });
        expect(ids(rowSessionsByProject(projects, placement))).toEqual([
            'a-early',
            'a-late',
            'b-early',
            'b-late',
        ]);
    });

    it('leaves nested and hidden Sessions out, and drops Projects that are not listed', () => {
        const placement = placeDelegatedSessions({
            projects: [project('alpha', 0)],
            selectedSessionId: undefined,
            sessions: [
                session('host', 'alpha'),
                createdBy('child', 'alpha', 'host', 'delegated'),
                createdBy('consult', 'alpha', 'host', 'consult'),
                session('elsewhere', 'worktree'),
            ],
        });
        const listed = rowSessionsByProject([project('alpha', 0)], placement);
        expect(ids(listed)).toEqual(['host']);
    });
});

describe('sidebarSessionOrder', () => {
    const sessions = [
        session('first', 'alpha', { sidebarOrder: 1 }),
        session('second', 'alpha', { sidebarOrder: 2 }),
        createdBy('first-consult', 'alpha', 'first', 'consult'),
        createdBy('first-child-2', 'beta', 'first', 'delegated', { sidebarOrder: 2 }),
        createdBy('first-child-1', 'beta', 'first', 'delegated', { sidebarOrder: 1 }),
        session('other', 'beta'),
    ];

    it('puts every nested Session right after its host, ahead of the host consults', () => {
        const order = sidebarSessionOrder(projects, sessions);
        expect(ids(order.all)).toEqual([
            'first',
            'first-child-1',
            'first-child-2',
            'first-consult',
            'second',
            'other',
        ]);
    });

    it('leaves hidden consults out of the navigable order', () => {
        const order = sidebarSessionOrder(projects, sessions);
        expect(ids(order.navigable)).toEqual([
            'first',
            'first-child-1',
            'first-child-2',
            'second',
            'other',
        ]);
    });

    it('keeps the selected consult navigable, sorted among the nested Sessions by sidebar order', () => {
        const order = sidebarSessionOrder(projects, sessions, 'first-consult');
        // The consult's sidebar order (0) precedes both delegated children (1 and 2).
        expect(ids(order.navigable)).toEqual([
            'first',
            'first-consult',
            'first-child-1',
            'first-child-2',
            'second',
            'other',
        ]);
        expect(ids(order.all)).toEqual(ids(order.navigable));
    });

    it('keeps a pinned Session in its Project slot', () => {
        const order = sidebarSessionOrder(projects, [
            session('plain', 'alpha', { sidebarOrder: 1 }),
            session('pinned', 'alpha', { pinnedAt: 9, sidebarOrder: 2 }),
        ]);
        expect(ids(order.all)).toEqual(['plain', 'pinned']);
    });

    it('lists a pinned delegated Session as its own row, not under the creator', () => {
        const order = sidebarSessionOrder(projects, [
            session('host', 'alpha', { sidebarOrder: 1 }),
            session('after', 'alpha', { sidebarOrder: 2 }),
            createdBy('pinned-child', 'alpha', 'host', 'delegated', {
                pinnedAt: 9,
                sidebarOrder: 3,
            }),
        ]);
        expect(ids(order.all)).toEqual(['host', 'after', 'pinned-child']);
    });

    it('skips an archived creator, so what it made is listed in its own slot', () => {
        const order = sidebarSessionOrder(projects, [
            session('archived', 'alpha', { archivedAt: 3 }),
            createdBy('orphan', 'alpha', 'archived', 'delegated'),
        ]);
        expect(ids(order.all)).toEqual(['orphan']);
    });
});

describe('firstSessionOfProject', () => {
    it('opens the first ordinary row of a Project', () => {
        const order = sidebarSessionOrder(projects, [
            session('a-one', 'alpha', { sidebarOrder: 1 }),
            session('a-two', 'alpha', { sidebarOrder: 2 }),
        ]);
        expect(firstSessionOfProject(order, 'alpha')?.id).toBe('a-one');
    });

    it('prefers a row of the Project over a Session nested under another Project host', () => {
        const order = sidebarSessionOrder(projects, [
            session('a-host', 'alpha'),
            createdBy('b-nested', 'beta', 'a-host', 'delegated'),
            session('b-row', 'beta', { sidebarOrder: 5 }),
        ]);
        expect(firstSessionOfProject(order, 'beta')?.id).toBe('b-row');
    });

    it('falls back to a nested Session when the Project has no row of its own', () => {
        const order = sidebarSessionOrder(projects, [
            session('a-host', 'alpha'),
            createdBy('b-nested', 'beta', 'a-host', 'delegated'),
        ]);
        expect(firstSessionOfProject(order, 'beta')?.id).toBe('b-nested');
    });

    it('never opens a hidden consult, and answers undefined for an empty Project', () => {
        const order = sidebarSessionOrder(projects, [
            session('a-host', 'alpha'),
            createdBy('b-consult', 'beta', 'a-host', 'consult'),
        ]);
        expect(firstSessionOfProject(order, 'beta')).toBeUndefined();
        expect(firstSessionOfProject(order, 'missing')).toBeUndefined();
    });
});

describe('placedPinnedSessions', () => {
    it('drops a pinned consult hidden under a listed ancestor, which takes no Pinned row', () => {
        const sessions = [
            session('host', 'alpha'),
            createdBy('consult', 'alpha', 'host', 'consult', { pinnedAt: 5 }),
        ];
        expect(ids(placedPinnedSessions(projects, sessions))).toEqual([]);
    });

    it('keeps a pinned consult that is selected, and ordinary pinned Sessions', () => {
        const sessions = [
            session('host', 'alpha', { pinnedAt: 2 }),
            createdBy('consult', 'alpha', 'host', 'consult', { pinnedAt: 5 }),
        ];
        expect(ids(placedPinnedSessions(projects, sessions))).toEqual(['host']);
    });
});
