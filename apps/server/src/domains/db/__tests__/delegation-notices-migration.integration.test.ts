import type Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../index';
import {
    databaseBeforeMigration,
    seedCreatorLinkedSessions,
} from './session-relation-migration.fixture';

const MIGRATION_TAG = '0009_delegation_notices';

function seed(database: Database.Database): void {
    seedCreatorLinkedSessions(database, 'consult');
    database.exec(`
        INSERT INTO agent_delegations (id, session_id, record_json)
            VALUES ('task-1', 'session-created', '{"receipt":{"status":"completed"}}');
    `);
}

async function upgrade() {
    const path = await databaseBeforeMigration(MIGRATION_TAG, seed);
    const upgraded = new CaxriDatabase(path);
    onTestFinished(() => upgraded.close());
    return upgraded;
}

function insertNotice(database: CaxriDatabase, kind: string, subjectId: string | null) {
    database.database
        .prepare(
            `INSERT INTO delegation_notices (id, delegation_id, kind, subject_id, state, caller_terminal_id, caller_launch_id, created_at, updated_at)
                VALUES (?, 'task-1', ?, ?, 'pending', 'terminal-1', 'launch-1', 1, 1)`,
        )
        .run(`${kind}:${subjectId ?? 'task-1'}`, kind, subjectId);
}

describe('delegation notices migration', () => {
    it('keeps the existing delegation and cascades its notices with it', async () => {
        const upgraded = await upgrade();
        insertNotice(upgraded, 'settled', null);
        insertNotice(upgraded, 'question', 'question-1');

        expect(upgraded.database.prepare('SELECT id FROM agent_delegations').pluck().all()).toEqual(
            ['task-1'],
        );
        upgraded.database.prepare("DELETE FROM agent_delegations WHERE id = 'task-1'").run();
        expect(
            upgraded.database.prepare('SELECT COUNT(*) FROM delegation_notices').pluck().get(),
        ).toBe(0);
    });

    it('requires a subject exactly for non-settled notices', async () => {
        const upgraded = await upgrade();
        expect(() => insertNotice(upgraded, 'settled', 'question-1')).toThrow(/CHECK/);
        expect(() => insertNotice(upgraded, 'question', null)).toThrow(/CHECK/);
    });
});
