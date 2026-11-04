import type Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../index';
import {
    databaseBeforeMigration,
    seedCreatorLinkedSessions,
} from './session-relation-migration.fixture';

const MIGRATION_TAG = '0008_delegation_history';

function seed(database: Database.Database): void {
    seedCreatorLinkedSessions(database, 'consult');
    database.exec(`
        INSERT INTO sessions (id, project_id, created_at, last_visited_at, session_activity_at, session_activity_reason, title, created_by_session_id, created_by_relation)
            VALUES ('session-delegated', 'project-1', 4, 4, 4, 'created', 'Delegated', 'session-creator', 'delegated');
    `);
}

async function upgrade() {
    const path = await databaseBeforeMigration(MIGRATION_TAG, seed);
    const upgraded = new CaxriDatabase(path);
    onTestFinished(() => upgraded.close());
    return upgraded;
}

function insertRow(database: CaxriDatabase, overrides: Record<string, string | number | null>) {
    const row = {
        delegation_id: 'task-1',
        root_delegation_id: 'task-1',
        session_id: 'session-x',
        project_id: 'project-1',
        provider: 'codex',
        outcome: 'completed',
        created_at: 1,
        settled_at: 2,
        ...overrides,
    };
    const names = Object.keys(row);
    database.database
        .prepare(
            `INSERT INTO delegation_history (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
        )
        .run(...Object.values(row));
}

describe(`${MIGRATION_TAG} migration`, () => {
    it('backfills an edge for every live Session that has a creator relation', async () => {
        const upgraded = await upgrade();

        expect(
            upgraded.database
                .prepare(
                    'SELECT session_id, parent_session_id, relation FROM delegation_edges ORDER BY session_id',
                )
                .all(),
        ).toEqual([
            {
                session_id: 'session-created',
                parent_session_id: 'session-creator',
                relation: 'consult',
            },
            {
                session_id: 'session-delegated',
                parent_session_id: 'session-creator',
                relation: 'delegated',
            },
        ]);
        expect(upgraded.database.pragma('foreign_key_check')).toEqual([]);
    });

    it.each([
        ['outcome', { outcome: 'running' }],
        ['failure', { outcome: 'failed', failure: 'sulking' }],
        ['a failure on a completed task', { outcome: 'completed', failure: 'provider_failed' }],
        ['summary source', { summary: 'x', summary_source: 'invented' }],
        ['a summary without its source', { summary: 'x' }],
        [
            'a summary on a task that did not complete',
            { outcome: 'failed', summary: 'x', summary_source: 'authored' },
        ],
        ['text on a compacted row', { title: 'x', compacted_at: 5 }],
        ['a settle before the creation', { created_at: 5, settled_at: 4 }],
        ['a usage scope without counters', { usage_scope: 'main-thread' }],
        ['a usage scope value', { usage_scope: 'galaxy', input_tokens: 1 }],
        ['a negative counter', { input_tokens: -1 }],
    ])('rejects %s', async (_name, overrides) => {
        const upgraded = await upgrade();

        expect(() => insertRow(upgraded, overrides)).toThrow(/CHECK constraint/u);
    });

    it('rejects an edge with an unknown relation', async () => {
        const upgraded = await upgrade();

        expect(() =>
            upgraded.database
                .prepare(
                    "INSERT INTO delegation_edges (session_id, parent_session_id, relation, created_at) VALUES ('a', 'b', 'adopted', 1)",
                )
                .run(),
        ).toThrow(/CHECK constraint/u);
    });

    it('keeps NULL counters NULL and survives deleting the Session and the task record', async () => {
        const upgraded = await upgrade();
        upgraded.database.exec(`
            INSERT INTO agent_delegations (id, session_id, record_json)
                VALUES ('task-1', 'session-created', '{"receipt":{"status":"running"}}');
        `);
        insertRow(upgraded, { session_id: 'session-created' });

        upgraded.database.exec("DELETE FROM agent_delegations WHERE id = 'task-1'");
        upgraded.database.exec("DELETE FROM sessions WHERE id = 'session-created'");
        upgraded.database.exec("DELETE FROM sessions WHERE id = 'session-creator'");

        expect(
            upgraded.database
                .prepare(
                    'SELECT input_tokens, output_tokens, usage_scope, title FROM delegation_history',
                )
                .all(),
        ).toEqual([{ input_tokens: null, output_tokens: null, usage_scope: null, title: null }]);
        expect(
            upgraded.database.prepare('SELECT count(*) AS n FROM delegation_edges').get(),
        ).toEqual({ n: 2 });
    });

    it('has no column that could hold a prompt', async () => {
        const upgraded = await upgrade();
        const names = (
            upgraded.database.prepare("PRAGMA table_info('delegation_history')").all() as Array<{
                name: string;
            }>
        ).map((column) => column.name);

        expect(names.filter((name) => /prompt|request|answer/u.test(name))).toEqual([]);
    });
});
