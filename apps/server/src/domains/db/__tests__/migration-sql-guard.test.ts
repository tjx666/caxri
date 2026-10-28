import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import { executableMigrationSql, MIGRATION_AUTHORING_RULE } from '../connection';
import { migrationManifest } from '../migrations/manifest';
import * as schema from '../schema';

const PERSISTENCE_REFERENCE = resolve(
    import.meta.dirname,
    '../../../../../../.agents/skills/project-architecture/references/persistence.md',
);

describe('migration SQL foreign_keys pragma guard', () => {
    it('accepts every bundled migration', () => {
        for (const migration of migrationManifest)
            expect(() => executableMigrationSql(migration.sql)).not.toThrow();
    });

    it('drops only the standalone toggles drizzle-kit writes around a table rebuild', () => {
        const generated = [
            'PRAGMA foreign_keys=OFF;',
            '\nCREATE TABLE `__new_t` (`id` text);\n',
            '\nDROP TABLE `t`;',
            '\nALTER TABLE `__new_t` RENAME TO `t`;',
            '\nPRAGMA foreign_keys=ON;',
            '\nCREATE INDEX `t_id` ON `t` (`id`);',
        ].join('--> statement-breakpoint');

        const executable = executableMigrationSql(generated);

        expect(executable).not.toMatch(/PRAGMA/u);
        expect(executable).toContain('ALTER TABLE `__new_t` RENAME TO `t`;');
        expect(executable).toContain('CREATE INDEX `t_id` ON `t` (`id`);');
    });

    it.each([
        {
            form: 'inline with another statement',
            sql: 'PRAGMA foreign_keys=OFF; CREATE TABLE t (id text);',
        },
        { form: 'hand-written spacing', sql: 'PRAGMA foreign_keys = ON;' },
        { form: 'a read', sql: 'PRAGMA foreign_keys;' },
    ])('rejects any other PRAGMA foreign_keys ($form) and names the sanctioned path', ({ sql }) => {
        expect(() => executableMigrationSql(sql)).toThrow(MIGRATION_AUTHORING_RULE);
    });

    it('states the same authoring rule as the persistence architecture reference', () => {
        const reference = readFileSync(PERSISTENCE_REFERENCE, 'utf8').replaceAll(/\s+/gu, ' ');
        expect(reference).toContain(MIGRATION_AUTHORING_RULE);
    });
});

/**
 * Generated columns per table, from the Drizzle schema. SQLite refuses to INSERT into one, yet drizzle-kit 0.31 lists
 * them in the copy statement of a table rebuild, so such a migration fails on every database that has a row.
 */
function generatedColumnsByTable(): Map<string, Set<string>> {
    const tables = new Map<string, Set<string>>();
    for (const table of Object.values(schema)) {
        if (!(table instanceof SQLiteTable)) continue;
        const config = getTableConfig(table);
        const generated = config.columns.filter((column) => column.generated !== undefined);
        if (generated.length > 0)
            tables.set(config.name, new Set(generated.map((column) => column.name)));
    }
    return tables;
}

describe('migration SQL generated column guard', () => {
    it('never copies a generated column during a table rebuild', () => {
        const generatedColumns = generatedColumnsByTable();
        expect(generatedColumns.get('terminals')).toContain('provider');
        for (const migration of migrationManifest)
            for (const match of migration.sql.matchAll(/INSERT INTO `__new_(\w+)`\(([^)]*)\)/gu)) {
                const [, table, columnList] = match;
                const copied = columnList
                    .split(',')
                    .map((column) => column.trim().replaceAll('"', ''));
                const generated = generatedColumns.get(table) ?? new Set<string>();
                expect(
                    copied.filter((column) => generated.has(column)),
                    `${migration.tag} copies a generated column of ${table}; remove it from both column lists of the INSERT`,
                ).toEqual([]);
            }
    });
});
