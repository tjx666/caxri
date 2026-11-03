import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../index';
import {
    databaseBeforeMigration,
    seedCreatorLinkedSessions,
} from './session-relation-migration.fixture';

const MIGRATION_TAG = '0005_session_created_by_relation_check';

describe(`${MIGRATION_TAG} migration`, () => {
    it('keeps rebuilt Sessions, their relations, and Terminals', async () => {
        const path = await databaseBeforeMigration(MIGRATION_TAG, (database) =>
            seedCreatorLinkedSessions(database, 'consult'),
        );

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());

        expect(upgraded.getSession('session-created')).toMatchObject({
            createdBySessionId: 'session-creator',
            createdByRelation: 'consult',
        });
        // A relation whose creator was deleted stays stored, but the read model reports neither field.
        expect(upgraded.getSession('session-orphan')).not.toHaveProperty('createdByRelation');
        expect(upgraded.getTerminal('terminal-1')).toMatchObject({ sessionId: 'session-created' });
        expect(upgraded.database.pragma('foreign_key_check')).toEqual([]);
    });

    it('rejects a relation outside the closed set but accepts each member and none', async () => {
        const path = await databaseBeforeMigration(MIGRATION_TAG, (database) =>
            seedCreatorLinkedSessions(database, 'consult'),
        );

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());
        const setRelation = (value: string | null) =>
            upgraded.database
                .prepare("UPDATE sessions SET created_by_relation = ? WHERE id = 'session-created'")
                .run(value);

        expect(() => setRelation('forked')).toThrow(/CHECK constraint failed/u);
        for (const relation of ['delegated', 'handoff', 'consult', null])
            expect(setRelation(relation).changes).toBe(1);
    });

    it('keeps the created Session and clears its creator link when the creating Session is deleted', async () => {
        const path = await databaseBeforeMigration(MIGRATION_TAG, (database) =>
            seedCreatorLinkedSessions(database, 'consult'),
        );

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());
        upgraded.deleteSession('session-creator');

        expect(upgraded.getSession('session-created')).toBeDefined();
        expect(upgraded.getSession('session-created')).not.toHaveProperty('createdBySessionId');
        expect(upgraded.getSession('session-created')).not.toHaveProperty('createdByRelation');
    });
});
