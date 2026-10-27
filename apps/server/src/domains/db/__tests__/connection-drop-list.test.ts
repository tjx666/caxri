import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import * as schema from '../full-schema';

/**
 * Tables the pre-baseline rebuild deliberately leaves in place. Adding a table to the schema without either dropping it
 * in `connection.ts` or listing it here fails the guard below, so the choice is always explicit.
 */
const RETAINED_ON_REBUILD: readonly string[] = [];

/**
 * Former names of tables the current schema still defines under a new name. A pre-baseline database may hold them, and
 * the replayed migration chain recreates them before renaming, so the rebuild drops them too.
 */
const RENAMED_TABLES: ReadonlySet<string> = new Set([
    'commander_inbox_replies',
    'commander_inbox_items',
    'commander_pending_notices',
    'commander_tasks',
]);

function droppedTables(): string[] {
    const source = readFileSync(resolve(import.meta.dirname, '../connection.ts'), 'utf8');
    return source
        .matchAll(/DROP TABLE IF EXISTS (\w+);/gu)
        .map((match) => match[1])
        .toArray();
}

function schemaTables(): string[] {
    const values: unknown[] = Object.values(schema);
    return values
        .filter((value): value is SQLiteTable => value instanceof SQLiteTable)
        .map((table) => getTableConfig(table).name);
}

/**
 * The clean-install cutoff rebuilds pre-baseline databases by dropping every table by name. A table added to the schema
 * but missing from that list would survive the rebuild with its old shape and then collide with the baseline migration;
 * a name left in the list after its table was removed is dead weight that hides which tables the cutoff really covers.
 */
describe('Pre-baseline rebuild DROP list', () => {
    it('drops each table once and only tables the current schema defines', () => {
        const dropped = droppedTables();
        expect(dropped.length).toBeGreaterThan(0);
        expect(new Set(dropped).size).toBe(dropped.length);
        expect(
            dropped.filter((name) => !schemaTables().includes(name) && !RENAMED_TABLES.has(name)),
        ).toEqual([]);
    });

    it('covers every table in the current schema', () => {
        const dropped = new Set([...droppedTables(), ...RETAINED_ON_REBUILD]);
        expect(schemaTables().filter((name) => !dropped.has(name))).toEqual([]);
    });
});
