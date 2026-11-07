import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../index';
import { databaseBeforeMigration } from './session-relation-migration.fixture';

const MIGRATION_TAG = '0017_session_turn_started_at';

const columns =
    'id, project_id, created_at, last_visited_at, session_activity_at, session_activity_reason, title, agent_activity_state';

describe(`${MIGRATION_TAG} migration`, () => {
    it('keeps existing Sessions without a turn start until their next turn stamps one', async () => {
        const path = await databaseBeforeMigration(MIGRATION_TAG, (database) => {
            database.exec(`
                INSERT INTO projects (id, root_path, title, created_at, last_visited_at)
                    VALUES ('project-1', '/tmp/caxri-turn-started-project', 'Project', 1, 1);
                INSERT INTO sessions (${columns}) VALUES
                    ('running', 'project-1', 1, 1, 5, 'agent_started', 'Running', 'running');
            `);
        });

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());

        expect(upgraded.getSession('running')?.turnStartedAt).toBeUndefined();

        upgraded.touchSessionActivity('running', 'user_submission');
        const submitted = upgraded.getSession('running');
        expect(submitted?.turnStartedAt).toBe(submitted?.sessionActivityAt);

        // Ending the turn moves the activity clock only, so Running keeps the row where its turn started.
        upgraded.touchSessionActivity('running', 'agent_completed');
        const completed = upgraded.getSession('running');
        expect(completed?.sessionActivityAt).toBeGreaterThan(submitted!.sessionActivityAt);
        expect(completed?.turnStartedAt).toBe(submitted?.turnStartedAt);
    });
});
