import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { expect, onTestFinished } from 'vitest';

import { executableMigrationSql } from '../connection';
import { BASELINE_SCHEMA_VERSION, migrationManifest } from '../migrations/manifest';

/**
 * A database exactly as the build before `tag` left it: every manifest entry before the tag, replayed through the
 * runner's SQL, then `seed` writes the rows the migration must carry across. Returns the file path to open.
 */
export async function databaseBeforeMigration(
    tag: string,
    seed: (database: Database.Database) => void,
): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-session-relation-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.db');
    const database = new Database(path);
    const index = migrationManifest.findIndex((migration) => migration.tag === tag);
    expect(index).toBeGreaterThan(0);
    for (const migration of migrationManifest.slice(0, index))
        database.exec(executableMigrationSql(migration.sql));
    database.pragma(`user_version = ${BASELINE_SCHEMA_VERSION + index - 1}`);
    seed(database);
    database.close();
    return path;
}

const sessionColumns =
    'id, project_id, created_at, last_visited_at, session_activity_at, session_activity_reason, title';

/**
 * One Project with a creating Session and the Session it created, which owns a Terminal. With `relation`, the created
 * Session also carries a `created_by_relation` and a second Session keeps a relation after its creator was deleted, as
 * the schema allows; only a build whose schema already has that column can write them.
 */
export function seedCreatorLinkedSessions(database: Database.Database, relation?: 'consult'): void {
    database.exec(`
        INSERT INTO projects (id, root_path, title, created_at, last_visited_at)
            VALUES ('project-1', '/tmp/caxri-session-relation-project', 'Project', 1, 1);
        INSERT INTO sessions (${sessionColumns})
            VALUES ('session-creator', 'project-1', 1, 1, 1, 'created', 'Creator');
        INSERT INTO sessions (${sessionColumns}, created_by_session_id)
            VALUES ('session-created', 'project-1', 2, 2, 2, 'created', 'Created', 'session-creator');
        INSERT INTO terminals (id, session_id, kind, cwd, title, order_index, last_process_state, created_at, updated_at)
            VALUES ('terminal-1', 'session-created', 'shell', '/tmp', 'Shell', 0, 'stopped', 2, 2);
    `);
    if (!relation) return;
    database.exec(`
        UPDATE sessions SET created_by_relation = '${relation}' WHERE id = 'session-created';
        INSERT INTO sessions (${sessionColumns}, created_by_relation)
            VALUES ('session-orphan', 'project-1', 3, 3, 3, 'created', 'Orphan', 'handoff');
    `);
}
