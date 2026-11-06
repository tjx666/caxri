import type Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../index';
import {
    databaseBeforeMigration,
    seedCreatorLinkedSessions,
} from './session-relation-migration.fixture';

const MIGRATION_TAG = '0015_delegation_hand_back_trigger';

function seed(database: Database.Database): void {
    seedCreatorLinkedSessions(database, 'delegated');
    database.exec(`
        INSERT INTO agent_delegations (id, session_id, record_json)
            VALUES ('task-1', 'session-created', '{"receipt":{"status":"completed"}}');
        INSERT INTO delegation_hand_backs (id, delegation_id, session_id, terminal_id, launch_id, provider_session_id, turn_id, input_epoch, caller_terminal_id, caller_launch_id, state, consumed_by, created_at, updated_at)
            VALUES ('grant-1', 'task-1', 'session-created', 'terminal-child', 'launch-child', 'native-1', 'turn-1', 0, 'terminal-1', 'launch-1', 'consumed', 'task-2', 1, 2);
    `);
}

async function upgrade() {
    const path = await databaseBeforeMigration(MIGRATION_TAG, seed);
    const upgraded = new CaxriDatabase(path);
    onTestFinished(() => upgraded.close());
    return upgraded;
}

describe(`${MIGRATION_TAG} migration`, () => {
    it('keeps every grant, reads an older one as the user’s, and leaves no foreign key broken', async () => {
        const upgraded = await upgrade();

        expect(
            upgraded.database
                .prepare('SELECT id, state, trigger, consumed_by FROM delegation_hand_backs')
                .all(),
        ).toEqual([{ id: 'grant-1', state: 'consumed', trigger: 'user', consumed_by: 'task-2' }]);
        expect(upgraded.database.pragma('foreign_key_check')).toEqual([]);
    });

    it('refuses an unknown trigger', async () => {
        const upgraded = await upgrade();

        expect(() =>
            upgraded.database.exec(
                `UPDATE delegation_hand_backs SET trigger = 'invented' WHERE id = 'grant-1'`,
            ),
        ).toThrow(/CHECK constraint/u);
    });
});
