import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import * as schema from '../schema';

const databaseDirectory = resolve(import.meta.dirname, '..');
const persistenceReference = readFileSync(
    resolve(
        import.meta.dirname,
        '../../../../../../.agents/skills/project-architecture/references/persistence.md',
    ),
    'utf8',
);

/**
 * Agents plan deletion and retention changes from the persistence reference's table list, so a table missing from it
 * hides its cascade owner and retention bound. Both checks below keep that reference and the `db/` layout predictable.
 */
describe('persistence reference', () => {
    it('names every schema table', () => {
        const tables = Object.values(schema)
            .filter((value) => is(value, SQLiteTable))
            .map((table) => getTableName(table));
        expect(tables.length).toBeGreaterThan(0);
        expect(tables.filter((name) => !persistenceReference.includes(`\`${name}\``))).toEqual([]);
    });

    it('never gives a top-level db module and a model the same file name', () => {
        const models = new Set(readdirSync(resolve(databaseDirectory, 'models')));
        const shared = readdirSync(databaseDirectory).filter(
            (name) => name.endsWith('.ts') && models.has(name),
        );
        expect(shared).toEqual([]);
    });
});
