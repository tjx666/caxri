import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase, SessionViewsModel } from '../index';

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
});
