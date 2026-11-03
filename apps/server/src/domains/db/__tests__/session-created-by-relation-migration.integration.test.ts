import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../index';
import {
    databaseBeforeMigration,
    seedCreatorLinkedSessions,
} from './session-relation-migration.fixture';

const MIGRATION_TAG = '0004_session_created_by_relation';

describe(`${MIGRATION_TAG} migration`, () => {
    it('keeps Sessions, their creator link, and Terminals, and leaves old Sessions without a relation', async () => {
        const path = await databaseBeforeMigration(MIGRATION_TAG, (database) =>
            seedCreatorLinkedSessions(database),
        );

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());

        expect(upgraded.getSession('session-created')).toMatchObject({
            projectId: 'project-1',
            createdBySessionId: 'session-creator',
        });
        expect(upgraded.getSession('session-created')).not.toHaveProperty('createdByRelation');
        expect(upgraded.getTerminal('terminal-1')).toMatchObject({ sessionId: 'session-created' });
        expect(upgraded.database.pragma('foreign_key_check')).toEqual([]);
    });

    it('records the relation of a Session created after the upgrade', async () => {
        const path = await databaseBeforeMigration(MIGRATION_TAG, (database) =>
            seedCreatorLinkedSessions(database),
        );

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());
        const { session } = upgraded.createSession('project-1', null, undefined, {
            createdBySessionId: 'session-creator',
            createdByRelation: 'delegated',
        });

        expect(upgraded.getSession(session.id)?.createdByRelation).toBe('delegated');
    });
});
