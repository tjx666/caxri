import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compareSessionPinnedOrder, compareSessionSidebarOrder } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../repository';

const directories: string[] = [];
const connections: CaxriDatabase[] = [];
afterEach(async () => {
    for (const connection of connections) connection.close();
    connections.length = 0;
    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.length = 0;
});

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-session-pinning-'));
    directories.push(directory);
    const path = join(directory, 'state.db');
    const database = new CaxriDatabase(path);
    connections.push(database);
    const project = database.createProject(directory);
    const other = database.createProject(join(directory, 'other'));
    const [a, b, c] = Array.from(
        { length: 3 },
        () => database.createSession(project.id, null).session,
    );
    const foreign = database.createSession(other.id, null).session;
    /**
     * The Pinned group as the sidebar builds it: every pinned Session across every Project, in Pinned order.
     */
    const pinnedOrder = () =>
        [...database.listSessions(project.id), ...database.listSessions(other.id)]
            .filter((row) => row.pinnedAt !== undefined && row.archivedAt === undefined)
            .toSorted(compareSessionPinnedOrder)
            .map((row) => row.id);
    const sidebarOrder = () =>
        database
            .listSessions(project.id)
            .filter((row) => row.archivedAt === undefined)
            .toSorted(compareSessionSidebarOrder)
            .map((row) => row.id);
    return { database, path, directory, project, a, b, c, foreign, pinnedOrder, sidebarOrder };
}

describe('Session pinning', () => {
    it('appends to the Pinned group without touching the Project order or the activity clock', async () => {
        const { database, a, b, pinnedOrder, sidebarOrder } = await fixture();
        const before = sidebarOrder();
        database.setSessionPinned(a.id, true);
        database.setSessionPinned(b.id, true);
        expect(pinnedOrder()).toEqual([a.id, b.id]);
        expect(sidebarOrder()).toEqual(before);
        expect(database.getSession(a.id)?.sessionActivityAt).toBe(a.sessionActivityAt);
    });

    it('survives a reopen', async () => {
        const { database, path, project, a, pinnedOrder } = await fixture();
        database.setSessionPinned(a.id, true);
        expect(pinnedOrder()).toEqual([a.id]);
        connections.splice(connections.indexOf(database), 1);
        database.close();
        const reopened = new CaxriDatabase(path);
        connections.push(reopened);
        expect(reopened.listSessions(project.id).find((row) => row.id === a.id)?.pinnedAt) //
            .toBeDefined();
    });

    it('unpinning leaves no order behind', async () => {
        const { database, a, pinnedOrder } = await fixture();
        database.setSessionPinned(a.id, true);
        database.setSessionPinned(a.id, false);
        expect(pinnedOrder()).toEqual([]);
        expect(database.getSession(a.id)).toMatchObject({
            pinnedAt: undefined,
            pinnedOrder: undefined,
        });
    });

    it('reorders across Projects, which is the whole point of one global group', async () => {
        const { database, a, b, foreign, pinnedOrder } = await fixture();
        for (const id of [a.id, b.id, foreign.id]) database.setSessionPinned(id, true);
        expect(pinnedOrder()).toEqual([a.id, b.id, foreign.id]);
        database.reorderPinnedSession(foreign.id, a.id, 'before');
        expect(pinnedOrder()).toEqual([foreign.id, a.id, b.id]);
    });

    it('leaves the Project group order alone when the Pinned group is reordered', async () => {
        const { database, a, b, pinnedOrder, sidebarOrder } = await fixture();
        database.setSessionPinned(a.id, true);
        database.setSessionPinned(b.id, true);
        const before = sidebarOrder();
        database.reorderPinnedSession(b.id, a.id, 'before');
        expect(pinnedOrder()).toEqual([b.id, a.id]);
        expect(sidebarOrder()).toEqual(before);
    });

    it('refuses a reorder whose rows are not both pinned, and a no-op self drop', async () => {
        const { database, a, b, pinnedOrder } = await fixture();
        database.setSessionPinned(a.id, true);
        expect(() => database.reorderPinnedSession(a.id, b.id, 'before')).toThrow();
        expect(() => database.reorderPinnedSession(b.id, a.id, 'before')).toThrow();
        expect(() => database.reorderPinnedSession(a.id, 'missing', 'before')).toThrow();
        database.reorderPinnedSession(a.id, a.id, 'before');
        expect(pinnedOrder()).toEqual([a.id]);
    });

    it('archiving clears the pin, and an archived Session cannot be pinned', async () => {
        const { database, a, pinnedOrder } = await fixture();
        database.setSessionPinned(a.id, true);
        database.archiveSession(a.id);
        expect(pinnedOrder()).toEqual([]);
        expect(() => database.setSessionPinned(a.id, true)).toThrow();
        // Restoring does not silently re-pin: the pin was a separate decision and is gone.
        database.unarchiveSessions([a.id]);
        expect(pinnedOrder()).toEqual([]);
    });

    it('re-pinning a Session puts it back at the end rather than its old position', async () => {
        const { database, a, b, pinnedOrder } = await fixture();
        database.setSessionPinned(a.id, true);
        database.setSessionPinned(b.id, true);
        database.reorderPinnedSession(b.id, a.id, 'before');
        expect(pinnedOrder()).toEqual([b.id, a.id]);
        database.setSessionPinned(b.id, false);
        database.setSessionPinned(b.id, true);
        expect(pinnedOrder()).toEqual([a.id, b.id]);
    });
});
