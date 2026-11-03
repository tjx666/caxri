import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../index';
import {
    databaseBeforeMigration,
    seedCreatorLinkedSessions,
} from './session-relation-migration.fixture';

const MIGRATION_TAG = '0006_session_results';

const result = {
    sessionId: 'session-created',
    delegationId: 'delegation-1',
    summary: 'Reviewed the retry design and found no problem.',
    source: 'authored' as const,
    completedAt: 5,
};

describe(`${MIGRATION_TAG} migration`, () => {
    it('keeps existing Sessions and stores a result for a delegated one', async () => {
        const path = await databaseBeforeMigration(MIGRATION_TAG, (database) =>
            seedCreatorLinkedSessions(database, 'consult'),
        );

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());

        expect(upgraded.getSession('session-created')).toMatchObject({
            createdBySessionId: 'session-creator',
            createdByRelation: 'consult',
        });
        upgraded.createdSessions.saveResult(result);
        expect(upgraded.createdSessions.results(['session-created', 'session-creator'])).toEqual(
            new Map([['session-created', result]]),
        );
        expect(upgraded.database.pragma('foreign_key_check')).toEqual([]);
    });

    it('rejects a summary source outside the closed set', async () => {
        const path = await databaseBeforeMigration(MIGRATION_TAG, (database) =>
            seedCreatorLinkedSessions(database, 'consult'),
        );

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());

        expect(() =>
            upgraded.database
                .prepare(
                    "INSERT INTO session_results (session_id, delegation_id, summary, summary_source, completed_at) VALUES ('session-created', 'delegation-1', 'Done', 'guessed', 1)",
                )
                .run(),
        ).toThrow(/CHECK constraint failed/u);
    });

    it('removes the result with its Session', async () => {
        const path = await databaseBeforeMigration(MIGRATION_TAG, (database) =>
            seedCreatorLinkedSessions(database, 'consult'),
        );

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());
        upgraded.createdSessions.saveResult(result);
        upgraded.deleteSession('session-created');

        expect(upgraded.createdSessions.results(['session-created']).size).toBe(0);
        expect(upgraded.database.pragma('foreign_key_check')).toEqual([]);
    });
});
