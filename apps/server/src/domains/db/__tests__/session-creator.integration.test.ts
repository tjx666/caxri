import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../connection';
import { CaxriDatabase } from '../index';
import { createDatabaseBeforeMigration, seedSessionWithChat } from './pre-migration.fixture';

async function openDatabase(): Promise<{ path: string; database: CaxriDatabase }> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-session-creator-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.db');
    return { path, database: new CaxriDatabase(path) };
}

describe('Session creator', () => {
    it('records the creating Session only when one is given', async () => {
        const { path, database } = await openDatabase();
        onTestFinished(() => database.close());
        const project = database.createProject(join(path, '..', 'project'));
        const { session: parent } = database.createSession(project.id, null);
        const { session: child } = database.createSession(project.id, null, undefined, {
            createdBySessionId: parent.id,
        });

        expect(child.createdBySessionId).toBe(parent.id);
        expect(database.getSession(child.id)?.createdBySessionId).toBe(parent.id);
        expect(parent).not.toHaveProperty('createdBySessionId');
    });

    it('forgets the creator when the creating Session is deleted, keeping the created one', async () => {
        const { path, database } = await openDatabase();
        onTestFinished(() => database.close());
        const project = database.createProject(join(path, '..', 'project'));
        const { session: parent } = database.createSession(project.id, null);
        const { session: child } = database.createSession(project.id, null, undefined, {
            createdBySessionId: parent.id,
        });

        database.deleteSession(parent.id);

        expect(database.getSession(child.id)).not.toHaveProperty('createdBySessionId');
    });

    it('forgets a creator in another Project when that Project is deleted', async () => {
        const { path, database } = await openDatabase();
        onTestFinished(() => database.close());
        const origin = database.createProject(join(path, '..', 'origin'));
        const target = database.createProject(join(path, '..', 'target'));
        const { session: parent } = database.createSession(origin.id, null);
        const { session: child } = database.createSession(target.id, null, undefined, {
            createdBySessionId: parent.id,
        });

        database.deleteProject(origin.id);

        expect(database.getSession(child.id)).not.toHaveProperty('createdBySessionId');
    });

    it('adds the column when upgrading across 0008_session_creator, keeping every Session', async () => {
        let sessionId = '';
        const { path } = await createDatabaseBeforeMigration('0008_session_creator', (raw) => {
            sessionId = seedSessionWithChat(raw).sessionId;
        });

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());
        expect(upgraded.getSession(sessionId)).toMatchObject({ id: sessionId });
        expect(upgraded.getSession(sessionId)).not.toHaveProperty('createdBySessionId');
        const check = new Database(path, { readonly: true });
        onTestFinished(() => {
            check.close();
        });
        expect(check.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    });
});
