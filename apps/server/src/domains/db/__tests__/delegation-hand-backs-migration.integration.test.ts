import type Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../index';
import {
    databaseBeforeMigration,
    seedCreatorLinkedSessions,
} from './session-relation-migration.fixture';

const MIGRATION_TAG = '0010_delegation_hand_backs';

function seed(database: Database.Database): void {
    seedCreatorLinkedSessions(database, 'consult');
    database.exec(`
        INSERT INTO agent_delegations (id, session_id, record_json)
            VALUES ('task-1', 'session-created', '{"receipt":{"status":"completed"}}');
        INSERT INTO delegation_notices (id, delegation_id, kind, state, caller_terminal_id, caller_launch_id, created_at, updated_at)
            VALUES ('settled:task-1', 'task-1', 'settled', 'delivered', 'terminal-1', 'launch-1', 1, 2);
    `);
}

async function upgrade() {
    const path = await databaseBeforeMigration(MIGRATION_TAG, seed);
    const upgraded = new CaxriDatabase(path);
    onTestFinished(() => upgraded.close());
    return upgraded;
}

function insertGrant(database: CaxriDatabase, overrides: Record<string, string | number | null>) {
    const row = {
        id: 'grant-1',
        delegation_id: 'task-1',
        session_id: 'session-created',
        terminal_id: 'terminal-child',
        launch_id: 'launch-child',
        provider_session_id: 'native-1',
        turn_id: 'turn-1',
        input_epoch: 0,
        caller_terminal_id: 'terminal-1',
        caller_launch_id: 'launch-1',
        state: 'pending',
        consumed_by: null,
        created_at: 1,
        updated_at: 1,
        ...overrides,
    };
    const names = Object.keys(row);
    database.database
        .prepare(
            `INSERT INTO delegation_hand_backs (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
        )
        .run(...Object.values(row));
}

function insertNotice(database: CaxriDatabase, kind: string, subjectId: string | null) {
    database.database
        .prepare(
            `INSERT INTO delegation_notices (id, delegation_id, kind, subject_id, state, caller_terminal_id, caller_launch_id, created_at, updated_at)
                VALUES (?, 'task-1', ?, ?, 'pending', 'terminal-1', 'launch-1', 1, 1)`,
        )
        .run(`${kind}:${subjectId}`, kind, subjectId);
}

describe(`${MIGRATION_TAG} migration`, () => {
    it('keeps the notices that existed before and leaves no foreign key broken', async () => {
        const upgraded = await upgrade();

        expect(
            upgraded.database.prepare('SELECT id, kind, state FROM delegation_notices').all(),
        ).toEqual([{ id: 'settled:task-1', kind: 'settled', state: 'delivered' }]);
        expect(upgraded.database.pragma('foreign_key_check')).toEqual([]);
    });

    it('lets a notice be a hand-back, and still refuses an unknown kind', async () => {
        const upgraded = await upgrade();

        insertNotice(upgraded, 'handback', 'grant-1');
        expect(() => insertNotice(upgraded, 'invented', 'x')).toThrow(/CHECK constraint/u);
        // The subject rule of the older kinds is unchanged: only a settled notice has none.
        expect(() => insertNotice(upgraded, 'handback', null)).toThrow(/CHECK constraint/u);
    });

    it('stores a grant and allows one pending grant per task', async () => {
        const upgraded = await upgrade();

        insertGrant(upgraded, {});
        expect(() => insertGrant(upgraded, { id: 'grant-2' })).toThrow(/UNIQUE constraint/u);
        insertGrant(upgraded, { id: 'grant-3', state: 'invalidated' });
        insertGrant(upgraded, { id: 'grant-4', state: 'consumed', consumed_by: 'task-2' });
    });

    it.each([
        ['an unknown state', { state: 'sulking' }],
        ['a consumed grant without its task', { state: 'consumed' }],
        ['a pending grant that names a task', { consumed_by: 'task-2' }],
    ])('rejects %s', async (_name, overrides) => {
        const upgraded = await upgrade();

        expect(() => insertGrant(upgraded, overrides)).toThrow(/CHECK constraint/u);
    });

    it('rejects a grant for a task that does not exist and drops it with the task', async () => {
        const upgraded = await upgrade();

        expect(() => insertGrant(upgraded, { delegation_id: 'missing' })).toThrow(
            /FOREIGN KEY constraint/u,
        );
        insertGrant(upgraded, {});
        upgraded.database.exec("DELETE FROM agent_delegations WHERE id = 'task-1'");

        expect(
            upgraded.database.prepare('SELECT count(*) AS n FROM delegation_hand_backs').get(),
        ).toEqual({ n: 0 });
    });
});
