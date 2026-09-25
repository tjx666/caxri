import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../connection';
import { CaxriDatabaseConnection } from '../database-connection';
import { migrationManifest, schemaVersionForMigration } from '../migrations/manifest';

it('adds failure detail to an existing Terminal without losing its state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-terminal-detail-upgrade-'));
    try {
        const path = join(directory, 'state.db');
        const previous = new Database(path);
        previous.pragma('foreign_keys = ON');
        const previousMigrations = migrationManifest.slice(
            0,
            migrationManifest.findIndex((migration) => migration.tag === '0027_dashing_ego'),
        );
        for (const migration of previousMigrations)
            previous.exec(migration.sql.replaceAll('--> statement-breakpoint', ''));
        previous
            .prepare(
                "INSERT INTO projects (id, root_path, display_title, created_at, last_opened_at) VALUES ('project-1', ?, 'Project', 1, 1)",
            )
            .run(directory);
        previous.exec(
            "INSERT INTO sessions (id, project_id, created_at, last_opened_at, display_title) VALUES ('session-1', 'project-1', 1, 1, 'Session')",
        );
        previous
            .prepare(
                "INSERT INTO terminals (id, session_id, kind, provider, cwd, title, icon, order_index, last_process_state, failure_reason, created_at, updated_at) VALUES ('terminal-1', 'session-1', 'claude', 'claude', ?, 'Claude Code', 'terminal', 0, 'failed', 'executable_not_found', 1, 1)",
            )
            .run(directory);
        previous.pragma(
            `user_version = ${schemaVersionForMigration('0026_delegation_terminal_ownership')}`,
        );
        previous.close();

        const upgraded = new CaxriDatabaseConnection(path);
        try {
            expect(upgraded.terminals.get('terminal-1')).toMatchObject({
                lastProcessState: 'failed',
                failureReason: 'executable_not_found',
                failureDetail: undefined,
            });
            upgraded.terminals.updateState(
                'terminal-1',
                'failed',
                'executable_not_found',
                'Claude Code CLI was not found',
            );
            expect(upgraded.terminals.get('terminal-1')?.failureDetail).toBe(
                'Claude Code CLI was not found',
            );
            upgraded.terminals.updateState('terminal-1', 'starting');
            expect(upgraded.terminals.get('terminal-1')?.failureDetail).toBeUndefined();
            expect(upgraded.database.pragma('user_version', { simple: true })).toBe(
                CURRENT_SCHEMA_VERSION,
            );
        } finally {
            upgraded.close();
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
