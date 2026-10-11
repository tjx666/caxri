import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import * as schema from '../full-schema';
import { migrationManifest } from '../migrations/manifest';
import type { SqliteSnapshot } from './drizzle-kit.fixture';
import { drizzleKit } from './drizzle-kit.fixture';

/**
 * `drizzle-kit generate` diffs the schema against the newest snapshot in `migrations/meta/`, which it wrote together
 * with the newest journal entry; the manifest test pins the manifest to that journal, so the newest manifest tag names
 * the same snapshot. Reading it is the only filesystem access here: the guard never writes into `migrations/`.
 */
function readLatestSnapshot(): SqliteSnapshot {
    const latestTag = migrationManifest.at(-1)?.tag ?? '';
    const prefix = latestTag.slice(0, latestTag.indexOf('_'));
    const path = resolve(import.meta.dirname, '../migrations/meta', `${prefix}_snapshot.json`);
    return JSON.parse(readFileSync(path, 'utf8')) as SqliteSnapshot;
}

/**
 * When one diff both adds and removes tables, views, or columns of one table, `drizzle-kit` asks on the terminal
 * whether a removed name was renamed. A test cannot answer that prompt and would hang, so such a diff is reported by
 * name instead of being handed to the generator. It is drift either way.
 */
function ambiguousRenames(previous: SqliteSnapshot, current: SqliteSnapshot): string[] {
    const conflicts: string[] = [];
    const compare = (scope: string, before: readonly string[], after: readonly string[]) => {
        const added = after.filter((name) => !before.includes(name));
        const removed = before.filter((name) => !after.includes(name));
        if (added.length > 0 && removed.length > 0)
            conflicts.push(`${scope}: added ${added.join(', ')}; removed ${removed.join(', ')}`);
    };
    compare('tables', Object.keys(previous.tables), Object.keys(current.tables));
    compare('views', Object.keys(previous.views), Object.keys(current.views));
    for (const [name, table] of Object.entries(current.tables)) {
        if (!Object.hasOwn(previous.tables, name)) continue;
        const before = Object.keys(previous.tables[name].columns);
        compare(`${name} columns`, before, Object.keys(table.columns));
    }
    return conflicts;
}

/**
 * Runs the same snapshot-and-diff steps as `drizzle-kit generate` (`prepareFromExports`, `generateSqliteSnapshot`,
 * `applySqliteSnapshotsDiff` with the default resolvers) in memory and returns the statements a new migration would
 * contain. An empty list is the CLI's "No schema changes, nothing to migrate".
 */
async function pendingMigration(schemaExports: Record<string, unknown>): Promise<string[]> {
    const previous = readLatestSnapshot();
    const current = await drizzleKit.generateSQLiteDrizzleJson(schemaExports, previous.id);
    const conflicts = ambiguousRenames(previous, current);
    return conflicts.length > 0 ? conflicts : drizzleKit.generateSQLiteMigration(previous, current);
}

describe('schema migration drift', () => {
    it('has a checked-in migration for every change in schema.ts', async () => {
        expect(
            await pendingMigration(schema),
            'schema.ts differs from the newest migration snapshot. Run `bunx --bun drizzle-kit generate` from the ' +
                'repository root, then add the generated migration to migrations/manifest.ts.',
        ).toEqual([]);
    });

    /**
     * Proves the guard is not vacuous: an extra exported table must surface as exactly one new statement. Compared
     * against the unprobed result so real drift fails only the test above, which carries the fix instructions.
     */
    it('reports a schema change that no migration covers', async () => {
        const driftProbe = sqliteTable('drift_probe', { id: text('id').primaryKey() });

        const unprobed = await pendingMigration(schema);
        const probed = await pendingMigration({ ...schema, driftProbe });

        expect(probed.filter((statement) => !unprobed.includes(statement))).toEqual([
            expect.stringContaining('CREATE TABLE `drift_probe`'),
        ]);
    });
});
