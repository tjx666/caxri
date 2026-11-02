import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { executableMigrationSql } from '../connection';
import { CaxriDatabase } from '../index';
import { BASELINE_SCHEMA_VERSION, migrationManifest } from '../migrations/manifest';

const MIGRATION_TAG = '0003_mobile_device_all_projects';

/**
 * A database exactly as the build before this migration left it: every manifest entry before the tag, replayed through
 * the runner's SQL, holding one paired phone with a fixed Project grant.
 */
async function databaseBeforeMigration(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-mobile-all-projects-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.db');
    const database = new Database(path);
    const index = migrationManifest.findIndex((migration) => migration.tag === MIGRATION_TAG);
    expect(index).toBeGreaterThan(0);
    for (const migration of migrationManifest.slice(0, index))
        database.exec(executableMigrationSql(migration.sql));
    database.pragma(`user_version = ${BASELINE_SCHEMA_VERSION + index - 1}`);
    database.exec(`
        INSERT INTO mobile_devices (device_id, display_name, platform, credential, generation, role, project_ids_json, created_at)
            VALUES ('device_1', 'Phone', 'android', 'secret', 1, 'control', '["project-1"]', 1);
    `);
    database.close();
    return path;
}

describe(`${MIGRATION_TAG} migration`, () => {
    it('keeps an existing paired phone on its fixed Project grant', async () => {
        const path = await databaseBeforeMigration();

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());

        expect(upgraded.credentials.mobileDevices.load().devices).toEqual([
            expect.objectContaining({
                deviceId: 'device_1',
                projectIds: ['project-1'],
                allProjects: false,
            }),
        ]);
    });
});
