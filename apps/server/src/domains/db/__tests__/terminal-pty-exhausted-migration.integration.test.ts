import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { executableMigrationSql } from '../connection';
import { CaxriDatabase } from '../index';
import { BASELINE_SCHEMA_VERSION, migrationManifest } from '../migrations/manifest';

const MIGRATION_TAG = '0001_terminal_pty_exhausted';

/**
 * A database exactly as the build before this migration left it: every manifest entry before the tag, replayed through
 * the runner's SQL, holding a Project, a Session, and a failed Terminal with its snapshot.
 */
async function databaseBeforeMigration(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-pty-exhausted-'));
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
        INSERT INTO terminals (id, session_id, kind, cwd, title, order_index, last_process_state, failure_reason, created_at, updated_at)
            VALUES ('terminal-1', 'session-1', 'shell', '/tmp', 'Shell', 0, 'failed', 'spawn_failed', 1, 1);
        INSERT INTO terminal_snapshots (terminal_id, encoding_version, cols, rows, line_count, byte_count, payload, updated_at)
            VALUES ('terminal-1', 1, 80, 24, 1, 2, 'hi', 1);
    `);
    database.close();
    return path;
}

describe(`${MIGRATION_TAG} migration`, () => {
    it('keeps existing Terminals and their snapshots and accepts the pty_exhausted failure reason', async () => {
        const path = await databaseBeforeMigration();

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());

        expect(upgraded.getTerminal('terminal-1')).toMatchObject({
            sessionId: 'session-1',
            failureReason: 'spawn_failed',
        });
        expect(upgraded.getSnapshot('terminal-1')?.payload).toBe('hi');
        upgraded.updateTerminalState('terminal-1', 'failed', 'pty_exhausted');
        expect(upgraded.getTerminal('terminal-1')?.failureReason).toBe('pty_exhausted');
        expect(upgraded.database.pragma('foreign_key_check')).toEqual([]);
    });
});
