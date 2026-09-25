import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../connection';
import { CaxriDatabaseConnection } from '../database-connection';
import { migrationManifest } from '../migrations/manifest';

it('upgrades the previous schema and reserves mobile Agent input without losing Session metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-mobile-submit-upgrade-'));
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
        previous.exec(
            "INSERT INTO sessions (id, project_id, created_at, last_opened_at, display_title) VALUES ('session-1', 'project-1', 1, 1, 'Session')",
        );
        previous.pragma(`user_version = ${CURRENT_SCHEMA_VERSION - 1}`);
        previous.close();

        const upgraded = new CaxriDatabaseConnection(path);
        try {
            expect(upgraded.sessions.get('session-1')?.displayTitle).toBe('Session');
            const identity = {
                deviceId: 'device-1',
                deviceGeneration: 1,
                clientMutationId: 'mutation-1',
                requestFingerprint: 'a'.repeat(64),
            };
            expect(upgraded.mobileAgentSubmitReceipts.reserve(identity)).toBe('reserved');
            upgraded.mobileAgentSubmitReceipts.markAccepted(identity);
            expect(upgraded.mobileAgentSubmitReceipts.find(identity)).toBe('accepted');
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
