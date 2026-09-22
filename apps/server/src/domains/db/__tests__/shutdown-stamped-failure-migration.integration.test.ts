import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../connection';
import { CaxriDatabaseConnection } from '../database-connection';
import { migrationManifest } from '../migrations/manifest';

/**
 * Every unclean Caxri exit used to stamp `failed` on every live Session, and nothing ever cleared it, so upgrading
 * users arrive carrying a backlog of Sessions permanently parked in Activity's Failed group. The migration rewrites
 * them from `last_session_activity_reason`, which survived the stamp and records the last real Agent event. See
 * https://github.com/tjx666/caxri/issues/1124.
 */
it('rewrites shutdown-stamped Session failures from their surviving activity reason', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-shutdown-failure-upgrade-'));
    try {
        const path = join(directory, 'state.db');
        const previous = new Database(path);
        previous.pragma('foreign_keys = ON');
        const previousMigrations = migrationManifest.slice(0, -1);
        for (const migration of previousMigrations)
            previous.exec(migration.sql.replaceAll('--> statement-breakpoint', ''));
        previous
            .prepare(
                "INSERT INTO projects (id, root_path, display_title, created_at, last_opened_at) VALUES ('project-1', ?, 'Project', 1, 1)",
            )
            .run(directory);
        const rows: Array<[id: string, state: string, reason: string]> = [
            ['stamped-completed', 'failed', 'agent_completed'],
            ['stamped-waiting', 'failed', 'agent_waiting'],
            ['stamped-started', 'failed', 'agent_started'],
            ['genuine-failure', 'failed', 'agent_failed'],
            ['untouched-waiting', 'waiting', 'agent_waiting'],
        ];
        const insert = previous.prepare(
            'INSERT INTO sessions (id, project_id, created_at, last_opened_at, display_title, last_activity_state, last_session_activity_reason) VALUES (?, ?, 1, 1, ?, ?, ?)',
        );
        for (const [id, state, reason] of rows) insert.run(id, 'project-1', id, state, reason);
        previous.pragma(`user_version = ${CURRENT_SCHEMA_VERSION - 1}`);
        previous.close();

        const upgraded = new CaxriDatabaseConnection(path);
        try {
            expect(upgraded.sessions.get('stamped-completed')?.lastActivityState).toBe('completed');
            expect(upgraded.sessions.get('stamped-waiting')?.lastActivityState).toBe('waiting');
            // `agent_started` only proves a turn began, so the pre-stamp state is genuinely unrecoverable.
            expect(upgraded.sessions.get('stamped-started')?.lastActivityState).toBe('unknown');
            // A Session whose own Agent reported the failure keeps it: that reason was never the shutdown's doing.
            expect(upgraded.sessions.get('genuine-failure')?.lastActivityState).toBe('failed');
            expect(upgraded.sessions.get('untouched-waiting')?.lastActivityState).toBe('waiting');
        } finally {
            upgraded.close();
        }
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
