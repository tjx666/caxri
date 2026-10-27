import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../index';

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
});
