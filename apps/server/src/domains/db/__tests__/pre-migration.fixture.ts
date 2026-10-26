import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { onTestFinished } from 'vitest';

import { executableMigrationSql } from '../connection';
import { migrationManifest, migrationsAfterBaseline } from '../migrations/manifest';

export type MigrationTag = (typeof migrationManifest)[number]['tag'];

export interface PreMigrationDatabase {
    /**
     * Path of the database file, left at the schema state just before the named migration.
     */
    path: string;
    /**
     * Directory that owns the file and is removed when the test finishes; safe for sibling fixtures.
     */
    directory: string;
}

/**
 * Creates a database file whose schema is exactly what a build shipped just before `tag`: the baseline plus every
 * manifest migration that precedes it, run through the real runner's {@link executableMigrationSql}, with `user_version`
 * set to the version before `tag`. Anchoring an N-1 upgrade test on a tag, instead of an offset from
 * `CURRENT_SCHEMA_VERSION` or hand-dropped later tables, keeps it valid when newer migrations are appended.
 *
 * `seed` receives the open connection at that schema state so a test can insert rows with raw SQL that only uses
 * columns existing then; the connection is closed before this resolves. Open the result with `CaxriDatabase` to run the
 * upgrade under test.
 */
export async function createDatabaseBeforeMigration(
    tag: Exclude<MigrationTag, '0000_baseline'>,
    seed?: (raw: Database.Database) => void,
): Promise<PreMigrationDatabase> {
    const target = migrationsAfterBaseline.find((migration) => migration.tag === tag);
    if (!target) throw new Error(`Unknown post-baseline migration tag ${tag}`);
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-pre-migration-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.db');
    const raw = new Database(path);
    try {
        for (const migration of migrationManifest) {
            if (migration.tag === tag) break;
            raw.exec(executableMigrationSql(migration.sql));
        }
        raw.pragma(`user_version = ${target.version - 1}`);
        seed?.(raw);
    } finally {
        raw.close();
    }
    return { path, directory };
}

/**
 * Inserts one Project and one Session with a Chat-capable Terminal using only baseline and `0001_terminal_surface`
 * columns, so it is valid for any tag from `0002_agent_session_usage` onward. Returns the ids it wrote.
 */
export function seedSessionWithChat(
    raw: Database.Database,
    provider: 'claude' | 'codex' = 'claude',
): { projectId: string; sessionId: string; terminalId: string } {
    const ids = { projectId: 'project-1', sessionId: 'session-1', terminalId: 'terminal-1' };
    raw.prepare(
        'INSERT INTO projects (id, root_path, display_title, created_at, last_opened_at) VALUES (?, ?, ?, 1, 1)',
    ).run(ids.projectId, '/tmp/caxri-seed-project', 'project');
    raw.prepare(
        "INSERT INTO sessions (id, project_id, created_at, last_opened_at, last_session_activity_at, display_title) VALUES (?, ?, 1, 1, 1, 'session')",
    ).run(ids.sessionId, ids.projectId);
    raw.prepare(
        "INSERT INTO terminals (id, session_id, kind, provider, cwd, title, icon, order_index, last_process_state, created_at, updated_at, surface) VALUES (?, ?, ?, ?, '/tmp/caxri-seed-project', 'chat', 'bot', 0, 'stopped', 1, 1, 'chat')",
    ).run(ids.terminalId, ids.sessionId, provider, provider);
    return ids;
}
