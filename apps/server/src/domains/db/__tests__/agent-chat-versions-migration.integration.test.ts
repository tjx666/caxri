import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { executableMigrationSql } from '../connection';
import { AgentChatStateModel, CaxriDatabase } from '../index';
import { BASELINE_SCHEMA_VERSION, migrationManifest } from '../migrations/manifest';

const MIGRATION_TAG = '0002_agent_chat_versions';

/**
 * A database exactly as the build before this migration left it: every manifest entry before the tag, replayed through
 * the runner's SQL, holding a Project, a Session, and a Chat Terminal.
 */
async function databaseBeforeMigration(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-chat-versions-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.db');
    const database = new Database(path);
    const index = migrationManifest.findIndex((migration) => migration.tag === MIGRATION_TAG);
    expect(index).toBeGreaterThan(0);
    for (const migration of migrationManifest.slice(0, index))
        database.exec(executableMigrationSql(migration.sql));
    database.pragma(`user_version = ${BASELINE_SCHEMA_VERSION + index - 1}`);
    database.exec(`
        INSERT INTO projects (id, root_path, title, created_at, last_visited_at)
            VALUES ('project-1', '${join(directory, 'project')}', 'Project', 1, 1);
        INSERT INTO sessions (id, project_id, created_at, last_visited_at, session_activity_at, session_activity_reason, title)
            VALUES ('session-1', 'project-1', 1, 1, 1, 'created', 'Session');
        INSERT INTO terminals (id, session_id, kind, cwd, title, order_index, agent_session_id, last_process_state, surface, created_at, updated_at)
            VALUES ('terminal-1', 'session-1', 'codex', '/tmp', 'Codex', 0, 'thread-1', 'stopped', 'chat', 1, 1);
    `);
    database.close();
    return path;
}

describe(`${MIGRATION_TAG} migration`, () => {
    it('keeps existing Chat Terminals and stores earlier versions for them', async () => {
        const path = await databaseBeforeMigration();

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());

        expect(upgraded.getTerminal('terminal-1')).toMatchObject({ agentSessionId: 'thread-1' });
        const versions = new AgentChatStateModel(upgraded.database).versions;
        versions.save({
            terminalId: 'terminal-1',
            id: 'version-1',
            agentSessionId: 'thread-1',
            anchorTurnId: null,
            items: [],
            turns: [],
        });
        expect(versions.list('terminal-1', 'thread-1').map((version) => version.id)).toEqual([
            'version-1',
        ]);
        expect(upgraded.database.pragma('foreign_key_check')).toEqual([]);
    });
});
