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
        database.createSession(project.id, 'shell', undefined, {
            windowKey: 'main',
            placement: 'newTab',
        }).session;
    return { create, database, project };
}

const strip = (database: CaxriDatabase, windowKey = 'main') =>
    database.windowOpenSessions.get(windowKey);

describe('Open Sessions per window', () => {
    it('appends a Session created with the explicit newTab placement and makes it active', () => {
        const { create, database } = fixture();
        const a = create();
        const b = create();
        expect(strip(database)).toEqual({ openSessionIds: [a.id, b.id], activeSessionId: b.id });
    });

    it('creates a Session like a plain select: the only entry first, then replacing the active one', () => {
        const { database, project } = fixture();
        const createPlain = () =>
            database.createSession(project.id, 'shell', undefined, { windowKey: 'main' }).session;
        const a = createPlain();
        expect(strip(database)).toEqual({ openSessionIds: [a.id], activeSessionId: a.id });
        const b = createPlain();
        expect(strip(database)).toEqual({ openSessionIds: [b.id], activeSessionId: b.id });
    });

    it('activates an already open Session without reordering the strip', () => {
        const { create, database } = fixture();
        const a = create();
        const b = create();
        database.selectSession(a.id, 'main');
        expect(strip(database)).toEqual({ openSessionIds: [a.id, b.id], activeSessionId: a.id });
    });

    it('navigates by replacing the active entry, like a browser tab', () => {
        const { create, database, project } = fixture();
        const a = create();
        const b = create();
        const elsewhere = database.createSession(project.id, 'shell', undefined, {
            selection: 'preserve',
        }).session;
        database.selectSession(a.id, 'main');
        database.selectSession(elsewhere.id, 'main');
        expect(strip(database)).toEqual({
            openSessionIds: [elsewhere.id, b.id],
            activeSessionId: elsewhere.id,
        });
    });

    it('keeps windows independent', () => {
        const { database, project } = fixture();
        const a = database.createSession(project.id, 'shell', undefined, {
            selection: 'preserve',
        }).session;
        database.selectSession(a.id, 'other');
        expect(strip(database, 'other')).toEqual({
            openSessionIds: [a.id],
            activeSessionId: a.id,
        });
        expect(strip(database, 'never-written')).toEqual({
            openSessionIds: [],
            activeSessionId: null,
        });
    });

    it('stores a requested strip but drops unknown and duplicate Sessions', () => {
        const { create, database } = fixture();
        const a = create();
        const b = create();
        database.selectSession(a.id, 'main');
        const stored = database.windowOpenSessions.set('main', [b.id, 'gone', a.id, b.id]);
        expect(stored).toEqual({ openSessionIds: [b.id, a.id], activeSessionId: a.id });
    });

    it('keeps the active Session across a reorder and moves to its neighbor when it is closed', () => {
        const { create, database } = fixture();
        const a = create();
        const b = create();
        const c = create();
        database.selectSession(b.id, 'main');
        expect(database.windowOpenSessions.set('main', [c.id, b.id, a.id]).activeSessionId).toBe(
            b.id,
        );
        expect(database.windowOpenSessions.set('main', [c.id, a.id])).toEqual({
            openSessionIds: [c.id, a.id],
            activeSessionId: a.id,
        });
        expect(database.windowOpenSessions.set('main', [c.id])).toEqual({
            openSessionIds: [c.id],
            activeSessionId: c.id,
        });
    });

    it('moves to the neighbor, then removes the Session, when the active Session is archived', () => {
        const { create, database } = fixture();
        const a = create();
        const b = create();
        const c = create();
        database.selectSession(b.id, 'main');
        database.archiveSession(b.id);
        expect(strip(database)).toEqual({ openSessionIds: [a.id, c.id], activeSessionId: c.id });
    });

    it('drops a closed non-active Session without moving the active one', () => {
        const { create, database } = fixture();
        const a = create();
        const b = create();
        database.deleteSession(a.id);
        expect(strip(database)).toEqual({ openSessionIds: [b.id], activeSessionId: b.id });
    });

    it('falls back to a Session of the same Project when the strip empties', () => {
        const { create, database, project } = fixture();
        const only = create();
        const sibling = database.createSession(project.id, 'shell', undefined, {
            selection: 'preserve',
        }).session;
        database.deleteSession(only.id);
        expect(strip(database)).toEqual({
            openSessionIds: [sibling.id],
            activeSessionId: sibling.id,
        });
    });

    it('prunes every window when its Project is hidden', () => {
        const { create, database, project } = fixture();
        create();
        const a = database.createSession(project.id, 'shell', undefined, {
            selection: 'preserve',
        }).session;
        database.selectSession(a.id, 'other');
        database.hideProject(project.id);
        expect(strip(database).openSessionIds).not.toContain(a.id);
        expect(strip(database, 'other').openSessionIds).not.toContain(a.id);
    });

    it('moves a Terminal into a new Session that replaces the active entry in the requesting window', () => {
        const { create, database } = fixture();
        const a = create();
        const terminal = database.listTerminals(a.id)[0];
        const moved = database.moveTerminalToNewSession(terminal.id, 'main');
        expect(strip(database)).toEqual({
            openSessionIds: [moved.session.id],
            activeSessionId: moved.session.id,
        });
    });

    describe('tear-off and window ownership', () => {
        function tornOff() {
            const context = fixture();
            const a = context.create();
            const b = context.create();
            const c = context.create();
            context.database.selectSession(b.id, 'main');
            const moved = context.database.windowOpenSessions.moveToWindow('main', 'win-1', b.id);
            return { ...context, a, b, c, moved };
        }

        it('moves a Session into a new window and gives the source its neighbor', () => {
            const { a, b, c, database, moved } = tornOff();
            expect(moved.target).toEqual({ openSessionIds: [b.id], activeSessionId: b.id });
            expect(moved.source).toEqual({ openSessionIds: [a.id, c.id], activeSessionId: c.id });
            expect(strip(database)).toEqual(moved.source);
            expect(strip(database, 'win-1')).toEqual(moved.target);
        });

        it('keeps the source active Session when another tab is torn off', () => {
            const { create, database } = fixture();
            const a = create();
            const b = create();
            database.selectSession(a.id, 'main');
            database.windowOpenSessions.moveToWindow('main', 'win-1', b.id);
            expect(strip(database)).toEqual({ openSessionIds: [a.id], activeSessionId: a.id });
        });

        it('refuses to move a Session that is not open, the last tab, or into a used window', () => {
            const { create, database, project } = fixture();
            const a = create();
            const b = create();
            const closed = database.createSession(project.id, 'shell', undefined, {
                selection: 'preserve',
            }).session;
            const reasonOf = (move: () => unknown): unknown => {
                try {
                    move();
                } catch (error) {
                    return (error as { details?: { reason?: string } }).details?.reason;
                }
                return undefined;
            };
            const { windowOpenSessions } = database;
            expect(
                reasonOf(() => windowOpenSessions.moveToWindow('main', 'win-1', closed.id)),
            ).toBe('not_open');
            windowOpenSessions.moveToWindow('main', 'win-1', b.id);
            expect(reasonOf(() => windowOpenSessions.moveToWindow('main', 'win-2', a.id))).toBe(
                'last_tab',
            );
            const c = create();
            expect(reasonOf(() => windowOpenSessions.moveToWindow('main', 'win-1', c.id))).toBe(
                'target_in_use',
            );
            expect(strip(database)).toEqual({
                openSessionIds: [a.id, c.id],
                activeSessionId: c.id,
            });
            expect(() => windowOpenSessions.moveToWindow('main', 'main', c.id)).toThrow(
                'new window',
            );
        });

        it('redirects a select of an owned Session to the owner and leaves the requester unchanged', () => {
            const { a, b, c, database } = tornOff();
            expect(database.selectSession(b.id, 'main')).toEqual({ ownerWindowKey: 'win-1' });
            expect(strip(database)).toEqual({
                openSessionIds: [a.id, c.id],
                activeSessionId: c.id,
            });
            expect(database.selectSession(a.id, 'win-1')).toEqual({ ownerWindowKey: 'main' });
            expect(strip(database, 'win-1')).toEqual({
                openSessionIds: [b.id],
                activeSessionId: b.id,
            });
            expect(strip(database).activeSessionId).toBe(a.id);
        });

        it('ignores ownership for a select without a window key and for the owner itself', () => {
            const { database, b } = tornOff();
            expect(database.selectSession(b.id)).toEqual({});
            expect(database.selectSession(b.id, 'win-1')).toEqual({});
        });

        it('drops Sessions another window owns from a requested strip', () => {
            const { a, b, c, database } = tornOff();
            const stored = database.windowOpenSessions.set('main', [c.id, b.id, a.id]);
            expect(stored.openSessionIds).toEqual([c.id, a.id]);
            expect(strip(database, 'win-1').openSessionIds).toEqual([b.id]);
        });

        it('frees a Session when its owner closes the tab', () => {
            const { b, database } = tornOff();
            database.windowOpenSessions.set('win-1', []);
            expect(database.selectSession(b.id, 'main')).toEqual({});
            expect(strip(database).activeSessionId).toBe(b.id);
        });

        it('releases a torn-off window but never the primary window', () => {
            const { database, b } = tornOff();
            database.windowOpenSessions.release('main');
            expect(strip(database).openSessionIds.length).toBeGreaterThan(0);
            database.windowOpenSessions.release('win-1');
            expect(database.windowOpenSessions.owner(b.id)).toBeUndefined();
            expect(database.windowOpenSessions.listTearOffs()).toEqual([]);
        });

        it('lists torn-off windows with Open Sessions for restore', () => {
            const { b, database } = tornOff();
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
            expect(cell).toEqual({
                'main': { openSessionIds: ['a'], activeSessionId: 'a' },
                'win-1': { openSessionIds: ['b'], activeSessionId: 'b' },
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

        it('prunes an archived Session from a torn-off window', () => {
            const { b, c, database } = tornOff();
            database.archiveSession(b.id);
            expect(strip(database, 'win-1').openSessionIds).not.toContain(b.id);
            expect(strip(database).openSessionIds).toContain(c.id);
        });
    });
});
