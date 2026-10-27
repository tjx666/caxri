import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compareSessionSidebarOrder } from '@caxri/protocol';
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
    const directory = await mkdtemp(join(tmpdir(), 'caxri-session-order-'));
    directories.push(directory);
    const path = join(directory, 'state.db');
    const database = new CaxriDatabase(path);
    connections.push(database);
    const project = database.createProject(directory);
    const [a, b, c] = Array.from(
        { length: 3 },
        () => database.createSession(project.id, null).session,
    );
    const order = () =>
        database
            .listSessions(project.id)
            .filter((row) => row.archivedAt === undefined)
            .toSorted(compareSessionSidebarOrder)
            .map((row) => row.id);
    return { database, path, directory, project, a, b, c, order };
}

describe('Session sidebar order', () => {
    it('persists a relative move without manufacturing activity or changing selection', async () => {
        const { database, path, project, a, b, c, order } = await fixture();
        database.selectSession(c.id, 'main');
        expect(order()).toEqual([c.id, b.id, a.id]);
        database.reorderSession(a.id, c.id, 'before');
        expect(order()).toEqual([a.id, c.id, b.id]);
        expect(database.getSession(a.id)?.sessionActivityAt).toBe(a.sessionActivityAt);
        expect(database.windowOpenSessions.get('main').activeSessionId).toBe(c.id);
        database.selectSession(b.id, 'main');
        expect(order()).toEqual([a.id, c.id, b.id]);
        connections.splice(connections.indexOf(database), 1);
        database.close();
        const reopened = new CaxriDatabase(path);
        connections.push(reopened);
        expect(
            reopened
                .listSessions(project.id)
                .toSorted(compareSessionSidebarOrder)
                .map((row) => row.id),
        ).toEqual([a.id, c.id, b.id]);
    });

    it.each([
        'user_submission',
        'agent_started',
        'agent_waiting',
        'agent_completed',
        'agent_failed',
    ] as const)(
        'promotes only the affected Session on %s and preserves dragged neighbors',
        async (reason) => {
            const { database, project, a, b, c, order } = await fixture();
            database.reorderSession(a.id, c.id, 'before');
            database.touchSessionActivity(b.id, reason);
            expect(order()).toEqual([b.id, a.id, c.id]);
            const fresh = database.createSession(project.id, null).session;
            expect(order()).toEqual([fresh.id, b.id, a.id, c.id]);
        },
    );

    it('resolves the anchor after intervening activity and lets later activity win', async () => {
        const { database, a, b, c, order } = await fixture();
        database.touchSessionActivity(b.id, 'agent_completed');
        database.reorderSession(a.id, b.id, 'before');
        expect(order()).toEqual([a.id, b.id, c.id]);
        database.touchSessionActivity(b.id, 'agent_waiting');
        expect(order()).toEqual([b.id, a.id, c.id]);
    });

    it('rejects missing, archived, and cross-Project anchors without partial changes', async () => {
        const { database, directory, a, b, c, order } = await fixture();
        const other = database.createProject(join(directory, 'other'));
        const foreign = database.createSession(other.id, null).session;
        for (const anchor of ['missing', foreign.id])
            expect(() => database.reorderSession(a.id, anchor, 'before')).toThrow();
        database.archiveSession(b.id);
        expect(() => database.reorderSession(a.id, b.id, 'before')).toThrow();
        expect(() => database.reorderSession(b.id, c.id, 'after')).toThrow();
        expect(order()).toEqual([c.id, a.id]);
        database.reorderSession(a.id, a.id, 'before');
        expect(order()).toEqual([c.id, a.id]);
    });

    it('lifts a restored Session above its Project without manufacturing activity', async () => {
        const { database, a, b, c, order } = await fixture();
        expect(order()).toEqual([c.id, b.id, a.id]);
        database.archiveSession(a.id);
        database.unarchiveSessions([a.id]);
        expect(order()).toEqual([a.id, c.id, b.id]);
        expect(database.getSession(a.id)).toMatchObject({
            sessionActivityAt: a.sessionActivityAt,
            sessionActivityReason: a.sessionActivityReason,
        });
    });

    it('restores a batch in the order it was given and leaves other Projects alone', async () => {
        const { database, directory, a, b, c, order } = await fixture();
        const other = database.createProject(join(directory, 'other'));
        const [first, second] = Array.from(
            { length: 2 },
            () => database.createSession(other.id, null).session,
        );
        const otherOrder = () =>
            database
                .listSessions(other.id)
                .toSorted(compareSessionSidebarOrder)
                .map((row) => row.id);
        expect(otherOrder()).toEqual([second.id, first.id]);
        database.archiveSession(a.id);
        database.archiveSession(c.id);
        database.unarchiveSessions([a.id, c.id]);
        expect(order()).toEqual([a.id, c.id, b.id]);
        expect(otherOrder()).toEqual([second.id, first.id]);
    });

    /**
     * The archive notice's Undo reverses one archive, so it asks for `unchanged`: a row that came back on top would
     * have quietly rewritten an order the user built by dragging.
     */
    it('keeps a dragged position when the restore asks to leave it unchanged', async () => {
        const { database, a, b, c, order } = await fixture();
        database.reorderSession(a.id, c.id, 'before');
        expect(order()).toEqual([a.id, c.id, b.id]);
        database.archiveSession(c.id);
        database.unarchiveSessions([c.id], 'unchanged');
        expect(order()).toEqual([a.id, c.id, b.id]);
    });

    it('uses manual sidebar order for fallback after archiving the selected Session', async () => {
        const { database, a, b, c } = await fixture();
        database.reorderSession(a.id, c.id, 'before');
        database.selectSession(b.id, 'main');
        database.archiveSession(b.id);
        expect(database.windowOpenSessions.get('main').activeSessionId).toBe(a.id);
    });
});
