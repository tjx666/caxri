import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../index';
import {
    databaseBeforeMigration,
    seedCreatorLinkedSessions,
} from './session-relation-migration.fixture';

const MIGRATION_TAG = '0011_session_relation_independent';

async function upgrade() {
    const path = await databaseBeforeMigration(MIGRATION_TAG, (database) => {
        seedCreatorLinkedSessions(database, 'consult');
        database.exec(`
            INSERT INTO delegation_edges (session_id, parent_session_id, relation, created_at)
                VALUES ('session-created', 'session-creator', 'consult', 2);
        `);
    });
    const upgraded = new CaxriDatabase(path);
    onTestFinished(() => upgraded.close());
    return upgraded;
}

describe(`${MIGRATION_TAG} migration`, () => {
    it('keeps the rebuilt Sessions, their relations, Terminals, and edges', async () => {
        const upgraded = await upgrade();

        expect(upgraded.getSession('session-created')).toMatchObject({
            createdBySessionId: 'session-creator',
            createdByRelation: 'consult',
        });
        expect(upgraded.getTerminal('terminal-1')).toMatchObject({ sessionId: 'session-created' });
        expect(upgraded.database.prepare('SELECT relation FROM delegation_edges').all()).toEqual([
            { relation: 'consult' },
        ]);
        expect(upgraded.database.pragma('foreign_key_check')).toEqual([]);
    });

    it('accepts an independent relation on a Session and an edge but still refuses an unknown one', async () => {
        const upgraded = await upgrade();
        const setRelation = (value: string) =>
            upgraded.database
                .prepare("UPDATE sessions SET created_by_relation = ? WHERE id = 'session-created'")
                .run(value);
        const setEdge = (value: string) =>
            upgraded.database
                .prepare(
                    "UPDATE delegation_edges SET relation = ? WHERE session_id = 'session-created'",
                )
                .run(value);

        expect(setRelation('independent').changes).toBe(1);
        expect(setEdge('independent').changes).toBe(1);
        expect(upgraded.getSession('session-created')).toMatchObject({
            createdByRelation: 'independent',
        });
        expect(() => setRelation('sibling')).toThrow(/CHECK constraint failed/u);
        expect(() => setEdge('sibling')).toThrow(/CHECK constraint failed/u);
    });
});
