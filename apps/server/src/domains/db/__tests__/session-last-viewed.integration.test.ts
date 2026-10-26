import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../connection';
import { CaxriDatabase, SessionViewsModel } from '../index';
import { createDatabaseBeforeMigration, seedSessionWithChat } from './pre-migration.fixture';

async function openDatabase(): Promise<{ path: string; database: CaxriDatabase }> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-session-last-viewed-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.db');
    return { path, database: new CaxriDatabase(path) };
}

describe('Session last viewed boundary', () => {
    it('is absent until the user first leaves the Session, then survives reopening the database', async () => {
        const { path, database } = await openDatabase();
        const project = database.createProject(join(path, '..', 'project'));
        const { session } = database.createSession(project.id, null);
        expect(session).not.toHaveProperty('lastViewedAt');

        expect(new SessionViewsModel(database.database).recordLeave(session.id, 1000)).toBe(true);
        database.close();

        const reopened = new CaxriDatabase(path);
        onTestFinished(() => reopened.close());
        expect(reopened.getSession(session.id)?.lastViewedAt).toBe(1000);
    });

    it('only moves forward and leaves the activity clock and visit time alone', async () => {
        const { path, database } = await openDatabase();
        onTestFinished(() => database.close());
        const project = database.createProject(join(path, '..', 'project'));
        const { session } = database.createSession(project.id, null);

        const views = new SessionViewsModel(database.database);
        views.recordLeave(session.id, 2000);
        expect(views.recordLeave(session.id, 1500)).toBe(false);
        expect(views.recordLeave('missing-session', 3000)).toBe(false);

        const after = database.getSession(session.id)!;
        expect(after.lastViewedAt).toBe(2000);
        expect(after.lastSessionActivityAt).toBe(session.lastSessionActivityAt);
        expect(after.lastOpenedAt).toBe(session.lastOpenedAt);
        expect(after.sidebarOrder).toBe(session.sidebarOrder);
    });

    it('adds the column when upgrading across 0012_session_last_viewed, keeping every Session', async () => {
        let sessionId = '';
        const { path } = await createDatabaseBeforeMigration('0012_session_last_viewed', (raw) => {
            sessionId = seedSessionWithChat(raw).sessionId;
        });

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());
        expect(upgraded.getSession(sessionId)).toMatchObject({ id: sessionId });
        expect(upgraded.getSession(sessionId)).not.toHaveProperty('lastViewedAt');
        const check = new Database(path, { readonly: true });
        onTestFinished(() => {
            check.close();
        });
        expect(check.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    });
});
