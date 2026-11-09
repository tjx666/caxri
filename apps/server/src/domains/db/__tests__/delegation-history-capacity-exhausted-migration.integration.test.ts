import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../index';
import { databaseBeforeMigration } from './session-relation-migration.fixture';

const MIGRATION_TAG = '0019_delegation_history_capacity_exhausted';

const INSERT = `INSERT INTO delegation_history (delegation_id, root_delegation_id, session_id, project_id, provider, outcome, failure, created_at, settled_at)
    VALUES (?, ?, 'session-x', 'project-1', 'codex', 'failed', ?, 1, 2)`;

describe(`${MIGRATION_TAG} migration`, () => {
    it('keeps settled history and accepts a launch refused at Terminal capacity', async () => {
        const path = await databaseBeforeMigration(MIGRATION_TAG, (database) => {
            database.prepare(INSERT).run('task-old', 'task-old', 'launch_failed');
        });
        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());

        upgraded.database.prepare(INSERT).run('task-new', 'task-new', 'capacity_exhausted');
        expect(
            upgraded.database
                .prepare(
                    'SELECT delegation_id, failure FROM delegation_history ORDER BY delegation_id',
                )
                .all(),
        ).toEqual([
            { delegation_id: 'task-new', failure: 'capacity_exhausted' },
            { delegation_id: 'task-old', failure: 'launch_failed' },
        ]);
        expect(() =>
            upgraded.database.prepare(INSERT).run('task-bad', 'task-bad', 'sulking'),
        ).toThrow(/CHECK constraint failed/);
    });
});
