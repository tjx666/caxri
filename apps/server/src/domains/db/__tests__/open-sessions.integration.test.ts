import { afterEach, describe, expect, it } from 'vitest';

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
        const { create, database } = fixture();
        const a = create();
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
        const a = create();
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
});
