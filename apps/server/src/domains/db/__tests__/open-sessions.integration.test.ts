import type { WindowOpenSessions } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { reconcileOpenSessions } from '../open-sessions';
import { CaxriDatabase } from '../repository';

const databases: CaxriDatabase[] = [];

afterEach(() => {
    for (const database of databases) database.close();
    databases.length = 0;
});

function fixture() {
    const database = new CaxriDatabase(':memory:');
    databases.push(database);
    const project = database.createProject('/synthetic/open-sessions');
    const create = () =>
        database.createSession(project.id, 'shell', undefined, { windowKey: 'main' }).session;
    /**
     * A Session that no window shows.
     */
    const idle = () =>
        database.createSession(project.id, 'shell', undefined, { selection: 'preserve' }).session;
    return { create, database, idle, project };
}

const window = (database: CaxriDatabase, windowKey = 'main') =>
    database.windowOpenSessions.get(windowKey);

const reasonOf = (move: () => unknown): unknown => {
    try {
        move();
    } catch (error) {
        return (error as { details?: { reason?: string } }).details?.reason;
    }
    return undefined;
};

describe('Open Sessions per window', () => {
    it('shows a created Session and replaces the previous one', () => {
        const { create, database } = fixture();
        const a = create();
        expect(window(database)).toEqual({ openSessionIds: [a.id], activeSessionId: a.id });
        const b = create();
        expect(window(database)).toEqual({ openSessionIds: [b.id], activeSessionId: b.id });
    });

    it('replaces the window Open Session when navigating to another Session', () => {
        const { create, database, idle } = fixture();
        const a = create();
        const b = idle();
        expect(database.selectSession(b.id, 'main')).toEqual({});
        expect(window(database)).toEqual({ openSessionIds: [b.id], activeSessionId: b.id });
        expect(database.selectSession(a.id, 'main')).toEqual({});
        expect(window(database)).toEqual({ openSessionIds: [a.id], activeSessionId: a.id });
    });

    it('collapses a legacy multi-entry record to the selected Session', () => {
        const { create, database, idle } = fixture();
        const a = create();
        const b = idle();
        database.setAppState('openSessionsByWindow', {
            main: { openSessionIds: [a.id, b.id], activeSessionId: a.id },
        });
        database.selectSession(b.id, 'main');
        expect(window(database)).toEqual({ openSessionIds: [b.id], activeSessionId: b.id });
    });

    it('lets a tab-strip cell claim only the Session its window shows', () => {
        const { create, database, idle } = fixture();
        const a = create();
        const b = idle();
        const c = idle();
        database.setAppState('openSessionsByWindow', {
            'main': { openSessionIds: [c.id], activeSessionId: c.id },
            'win-1': { openSessionIds: [a.id, b.id], activeSessionId: a.id },
        });
        // `b` sits in win-1's old strip but win-1 shows `a`, so main may select `b` instead of being redirected.
        expect(database.windowOpenSessions.owner(b.id, 'main')).toBeUndefined();
        expect(database.windowOpenSessions.owner(a.id, 'main')).toBe('win-1');
    });

    it('reads a stored legacy previewSessionId back without it after a write', () => {
        const { create, database, idle } = fixture();
        const a = create();
        const b = idle();
        database.setAppState('openSessionsByWindow', {
            main: { openSessionIds: [a.id, b.id], activeSessionId: a.id, previewSessionId: a.id },
        } as Record<string, WindowOpenSessions>);
        database.selectSession(b.id, 'main');
        expect(database.getAppState('openSessionsByWindow')?.main).toStrictEqual({
            openSessionIds: [b.id],
            activeSessionId: b.id,
        });
    });

    it('drops a legacy previewSessionId when reconcile rewrites the record', () => {
        const { create, database, idle } = fixture();
        const a = create();
        const b = idle();
        database.setAppState('openSessionsByWindow', {
            main: { openSessionIds: [a.id, b.id], activeSessionId: a.id, previewSessionId: b.id },
        } as Record<string, WindowOpenSessions>);
        database.archiveSession(b.id);
        expect(database.getAppState('openSessionsByWindow')?.main).toStrictEqual({
            openSessionIds: [a.id],
            activeSessionId: a.id,
        });
    });

    it("lists the Sessions other windows own, never the requesting window's own", () => {
        const { create, database, idle } = fixture();
        const a = create();
        const elsewhere = idle();
        database.selectSession(elsewhere.id, 'other');
        expect(database.windowOpenSessions.ownedElsewhere('main')).toEqual([elsewhere.id]);
        expect(database.windowOpenSessions.ownedElsewhere('other')).toEqual([a.id]);
    });

    it('keeps windows independent', () => {
        const { database, idle } = fixture();
        const a = idle();
        database.selectSession(a.id, 'other');
        expect(window(database, 'other')).toEqual({
            openSessionIds: [a.id],
            activeSessionId: a.id,
        });
        expect(window(database, 'never-written')).toEqual({
            openSessionIds: [],
            activeSessionId: null,
        });
    });

    it('falls back to a Session of the same Project when the window empties', () => {
        const { create, database, idle } = fixture();
        const only = create();
        const sibling = idle();
        database.deleteSession(only.id);
        expect(window(database)).toEqual({
            openSessionIds: [sibling.id],
            activeSessionId: sibling.id,
        });
    });

    it('moves to a fallback Session when the shown Session is archived', () => {
        const { create, database, idle } = fixture();
        const a = create();
        const sibling = idle();
        database.archiveSession(a.id);
        expect(window(database)).toEqual({
            openSessionIds: [sibling.id],
            activeSessionId: sibling.id,
        });
    });

    it('prunes every window when its Project is hidden', () => {
        const { create, database, idle, project } = fixture();
        create();
        const a = idle();
        database.selectSession(a.id, 'other');
        database.hideProject(project.id);
        expect(window(database).openSessionIds).not.toContain(a.id);
        expect(window(database, 'other').openSessionIds).not.toContain(a.id);
    });

    it('moves a Terminal into a new Session that replaces the window Open Session', () => {
        const { create, database } = fixture();
        const a = create();
        const terminal = database.listTerminals(a.id)[0];
        const moved = database.moveTerminalToNewSession(terminal.id, 'main');
        expect(window(database)).toEqual({
            openSessionIds: [moved.session.id],
            activeSessionId: moved.session.id,
        });
    });

    describe('new window and window ownership', () => {
        function opened() {
            const context = fixture();
            const a = context.create();
            const b = context.idle();
            const moved = context.database.windowOpenSessions.moveToWindow('main', 'win-1', b.id);
            return { ...context, a, b, moved };
        }

        it('opens a Session the source does not show in a new window and keeps the source Session', () => {
            const { a, b, database, moved } = opened();
            expect(moved.target).toEqual({ openSessionIds: [b.id], activeSessionId: b.id });
            expect(moved.source).toEqual({ openSessionIds: [a.id], activeSessionId: a.id });
            expect(window(database)).toEqual(moved.source);
            expect(window(database, 'win-1')).toEqual(moved.target);
        });

        it('drops the moved id from a legacy source record and keeps its active Session', () => {
            const { create, database, idle } = fixture();
            const a = create();
            const b = idle();
            database.setAppState('openSessionsByWindow', {
                main: { openSessionIds: [a.id, b.id], activeSessionId: a.id },
            });
            database.windowOpenSessions.moveToWindow('main', 'win-1', b.id);
            expect(window(database)).toEqual({ openSessionIds: [a.id], activeSessionId: a.id });
        });

        it('refuses the shown Session, a Session another window owns, and a used target window', () => {
            const { a, b, database, idle } = opened();
            const { windowOpenSessions } = database;
            expect(reasonOf(() => windowOpenSessions.moveToWindow('main', 'win-2', a.id))).toBe(
                'shown_session',
            );
            expect(reasonOf(() => windowOpenSessions.moveToWindow('main', 'win-2', b.id))).toBe(
                'open_elsewhere',
            );
            const c = idle();
            expect(reasonOf(() => windowOpenSessions.moveToWindow('main', 'win-1', c.id))).toBe(
                'target_in_use',
            );
            expect(window(database)).toEqual({ openSessionIds: [a.id], activeSessionId: a.id });
            expect(() => windowOpenSessions.moveToWindow('main', 'main', c.id)).toThrow(
                'new window',
            );
        });

        it('redirects a select of an owned Session to the owner and leaves the requester unchanged', () => {
            const { a, b, database } = opened();
            expect(database.selectSession(b.id, 'main')).toEqual({ ownerWindowKey: 'win-1' });
            expect(window(database)).toEqual({ openSessionIds: [a.id], activeSessionId: a.id });
            expect(database.selectSession(a.id, 'win-1')).toEqual({ ownerWindowKey: 'main' });
            expect(window(database, 'win-1')).toEqual({
                openSessionIds: [b.id],
                activeSessionId: b.id,
            });
        });

        it('ignores ownership for a select without a window key and for the owner itself', () => {
            const { database, b } = opened();
            expect(database.selectSession(b.id)).toEqual({});
            expect(database.selectSession(b.id, 'win-1')).toEqual({});
        });

        it('frees a Session when its owner navigates away', () => {
            const { a, b, database, idle } = opened();
            database.selectSession(idle().id, 'win-1');
            expect(database.selectSession(b.id, 'main')).toEqual({});
            expect(window(database)).toEqual({ openSessionIds: [b.id], activeSessionId: b.id });
            expect(database.windowOpenSessions.owner(a.id)).toBeUndefined();
        });

        it('releases a new window but never the primary window', () => {
            const { database, b } = opened();
            database.windowOpenSessions.release('main');
            expect(window(database).openSessionIds.length).toBeGreaterThan(0);
            database.windowOpenSessions.release('win-1');
            expect(database.windowOpenSessions.owner(b.id)).toBeUndefined();
            expect(database.windowOpenSessions.listTearOffs()).toEqual([]);
        });

        it('lists new windows with Open Sessions for restore', () => {
            const { b, database } = opened();
            expect(database.windowOpenSessions.listTearOffs()).toEqual([
                { windowKey: 'win-1', openSessionIds: [b.id], activeSessionId: b.id },
            ]);
        });

        it('heals a duplicated cell on reconcile, keeping the primary window entry', () => {
            let cell: Record<string, WindowOpenSessions> | undefined = {
                'win-1': { openSessionIds: ['b', 'a'], activeSessionId: 'a' },
                'main': { openSessionIds: ['a'], activeSessionId: 'a' },
            };
            const store = {
                appState: {
                    get: () => cell,
                    set: (_key: string, value: Record<string, WindowOpenSessions>) => {
                        cell = value;
                    },
                },
            } as unknown as Parameters<typeof reconcileOpenSessions>[0];
            reconcileOpenSessions(store, new Set(['a', 'b']), () => {});
            // `b` was only a hidden strip entry, so it is not promoted: the window shows nothing until it navigates.
            expect(cell).toEqual({
                'main': { openSessionIds: ['a'], activeSessionId: 'a' },
                'win-1': { openSessionIds: [], activeSessionId: null },
            });
        });

        it('never gives a fallback Session another window already owns', () => {
            let cell: Record<string, WindowOpenSessions> | undefined = {
                'main': { openSessionIds: ['gone'], activeSessionId: 'gone' },
                'win-1': { openSessionIds: ['b'], activeSessionId: 'b' },
            };
            const store = {
                appState: {
                    get: () => cell,
                    set: (_key: string, value: Record<string, WindowOpenSessions>) => {
                        cell = value;
                    },
                },
            } as unknown as Parameters<typeof reconcileOpenSessions>[0];
            reconcileOpenSessions(store, new Set(['b']), () => 'b');
            expect(cell).toEqual({
                'main': { openSessionIds: [], activeSessionId: null },
                'win-1': { openSessionIds: ['b'], activeSessionId: 'b' },
            });
        });

        it('prunes an archived Session from a new window', () => {
            const { b, database } = opened();
            database.archiveSession(b.id);
            expect(window(database, 'win-1').openSessionIds).not.toContain(b.id);
        });
    });
});
