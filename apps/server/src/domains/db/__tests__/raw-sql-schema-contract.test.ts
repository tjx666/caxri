import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { executableMigrationSql } from '../connection';
import { migrationManifest } from '../migrations/manifest';

/**
 * Tests and E2E specs seed state with raw SQL that bypasses the models, so a schema change (a dropped column, a column
 * turned generated) breaks them without touching their files, and the changed-file gate never selects them. Importing
 * them `?raw` puts them in this test's module graph, and the migration manifest pulls in every migration, so a schema
 * change or a new raw statement reruns this check. See issue #2812.
 */
const sources = {
    ...import.meta.glob('../../../../../../apps/*/src/**/__tests__/**/*.ts', {
        query: '?raw',
        import: 'default',
        eager: true,
    }),
    ...import.meta.glob('../../../../../../e2e/**/*.ts', {
        query: '?raw',
        import: 'default',
        eager: true,
    }),
} as Record<string, string>;

/**
 * Tables of other SQLite databases that tests also seed: Codex's own state database and the session-search index.
 * Listed by name instead of skipping whatever the Caxri schema lacks, so a table this schema drops still fails here.
 */
const FOREIGN_TABLES = new Set([
    'messages',
    'messages_fts',
    'thread_spawn_edges',
    'thread_turns',
    'threads',
    'transcripts',
]);

const SELF = 'raw-sql-schema-contract.test.ts';
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));

/**
 * A static `.prepare('...')` argument: a quoted string, or a template literal with no interpolation. Arguments that do
 * not start with a SQL verb belong to unrelated `prepare` methods (such as the Session reference service).
 */
const PREPARED_ARGUMENT = /\.prepare\(\s*(?:'([^'\\]*)'|"([^"\\]*)"|`([^`$\\]*)`)\s*(?:,\s*)?\)/gu;
const SQL_VERB = /^\s*(?:DELETE|INSERT|REPLACE|SELECT|UPDATE|WITH)\b/iu;

function openCurrentSchema(): Database.Database {
    const database = new Database(':memory:');
    for (const migration of migrationManifest) database.exec(executableMigrationSql(migration.sql));
    return database;
}

function preparedStatements(): Array<{ location: string; sql: string }> {
    return Object.entries(sources)
        .filter(([path]) => !path.endsWith(SELF))
        .flatMap(([path, source]) =>
            source
                .matchAll(PREPARED_ARGUMENT)
                .map((match) => ({
                    location: `${relative(REPOSITORY_ROOT, fileURLToPath(new URL(path, import.meta.url)))}:${source.slice(0, match.index).split('\n').length}`,
                    // Exactly one quote form matched; the other groups are undefined and join as empty.
                    sql: match.slice(1).join(''),
                }))
                .toArray(),
        )
        .filter(({ sql }) => SQL_VERB.test(sql));
}

describe('raw SQL in tests and E2E specs', () => {
    it('finds the statements it guards', () => {
        expect(preparedStatements().length).toBeGreaterThan(20);
    });

    it('compiles against the current schema', () => {
        const database = openCurrentSchema();
        const failures = preparedStatements().flatMap(({ location, sql }) => {
            try {
                database.prepare(sql);
                return [];
            } catch (error) {
                const message = (error as Error).message;
                const table = /^no such table: (\w+)$/u.exec(message)?.[1];
                return table && FOREIGN_TABLES.has(table) ? [] : [`${location}: ${message}`];
            }
        });
        database.close();
        expect(failures).toEqual([]);
    });

    it('rejects a write to a generated column', () => {
        const database = openCurrentSchema();
        expect(() =>
            database.prepare('UPDATE terminals SET kind = ?, provider = ? WHERE id = ?'),
        ).toThrow(/generated column "provider"/u);
        database.close();
    });
});
