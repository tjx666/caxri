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

    it('records how the creator started a Session, only together with the creator', async () => {
        const { path, database } = await openDatabase();
        onTestFinished(() => database.close());
        const project = database.createProject(join(path, '..', 'project'));
        const { session: creator } = database.createSession(project.id, null);
        const created = (options: Parameters<typeof database.createSession>[3]) =>
            database.createSession(project.id, null, undefined, options).session;

        for (const relation of ['delegated', 'handoff', 'consult'] as const) {
            const session = created({
                createdBySessionId: creator.id,
                createdByRelation: relation,
            });
            expect(session.createdByRelation).toBe(relation);
            expect(database.getSession(session.id)?.createdByRelation).toBe(relation);
        }
        // Caxri Bot's Sessions name their creator without a relation.
        expect(created({ createdBySessionId: creator.id })).not.toHaveProperty('createdByRelation');
        // A relation without a creator is never stored.
        const orphan = created({ createdByRelation: 'delegated' });
        expect(orphan).not.toHaveProperty('createdByRelation');
        expect(
            database.database
                .prepare('SELECT created_by_relation AS relation FROM sessions WHERE id = ?')
                .get(orphan.id),
        ).toEqual({ relation: null });
        expect(creator).not.toHaveProperty('createdByRelation');
    });

    it('omits the relation once the creating Session is deleted', async () => {
        const { path, database } = await openDatabase();
        onTestFinished(() => database.close());
        const project = database.createProject(join(path, '..', 'project'));
        const { session: creator } = database.createSession(project.id, null);
        const { session } = database.createSession(project.id, null, undefined, {
            createdBySessionId: creator.id,
            createdByRelation: 'consult',
        });

        database.deleteSession(creator.id);

        const kept = database.getSession(session.id);
        expect(kept).not.toHaveProperty('createdBySessionId');
        expect(kept).not.toHaveProperty('createdByRelation');
        // The column outlives its creator by design; only the read model hides it.
        expect(
            database.database
                .prepare('SELECT created_by_relation AS relation FROM sessions WHERE id = ?')
                .get(session.id),
        ).toEqual({ relation: 'consult' });
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
