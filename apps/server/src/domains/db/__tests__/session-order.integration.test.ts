import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compareSessionSidebarOrder } from '@caxri/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION, migrationManifest } from '../migrations/manifest';
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
        database.selectSession(c.id);
        expect(order()).toEqual([c.id, b.id, a.id]);
        database.reorderSession(a.id, c.id, 'before');
        expect(order()).toEqual([a.id, c.id, b.id]);
        expect(database.getSession(a.id)?.lastSessionActivityAt).toBe(a.lastSessionActivityAt);
        expect(database.getAppState('lastSelectedSessionId')).toBe(c.id);
        database.selectSession(b.id);
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

    it('uses manual sidebar order for fallback after archiving the selected Session', async () => {
        const { database, a, b, c } = await fixture();
        database.reorderSession(a.id, c.id, 'before');
        database.selectSession(b.id);
        database.archiveSession(b.id);
        expect(database.getAppState('lastSelectedSessionId')).toBe(a.id);
    });

    it('backfills the previous schema in its exact visible activity order', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-session-order-upgrade-'));
        directories.push(directory);
        const path = join(directory, 'state.db');
        const previous = new Database(path);
        const previousMigrations = migrationManifest.slice(0, -1);
        for (const migration of previousMigrations)
            previous.exec(migration.sql.replaceAll('--> statement-breakpoint', ''));
        previous
            .prepare(
                'INSERT INTO projects (id, root_path, display_title, created_at, last_opened_at) VALUES (?, ?, ?, 1, 1)',
            )
            .run('p', directory, 'Project');
        const insert = previous.prepare(
            'INSERT INTO sessions (id, project_id, display_title, created_at, last_opened_at, last_session_activity_at) VALUES (?, ?, ?, ?, 999, ?)',
        );
        insert.run('a', 'p', 'Alpha', 1, 10);
        insert.run('b', 'p', 'Beta', 2, 20);
        insert.run('c', 'p', 'Gamma', 3, 20);
        previous.pragma(`user_version = ${CURRENT_SCHEMA_VERSION - 1}`);
        previous.close();
        const upgraded = new CaxriDatabase(path);
        connections.push(upgraded);
        expect(
            upgraded
                .listSessions('p')
                .toSorted(compareSessionSidebarOrder)
                .map((row) => row.id),
        ).toEqual(['c', 'b', 'a']);
        expect(upgraded.getSession('a')?.lastSessionActivityAt).toBe(10);
    });
});
