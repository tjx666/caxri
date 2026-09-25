import { describe, expect, it } from 'vitest';

import {
    assertMigrationManifestMatchesJournal,
    CURRENT_SCHEMA_VERSION,
    migrationManifest,
    PRESERVED_SCHEMA_VERSION,
    preservingMigrations,
} from '../migrations/manifest';
import migrationJournal from '../migrations/meta/_journal.json';

describe('migration manifest', () => {
    it('matches every Drizzle journal entry in order and derives schema versions', () => {
        expect(migrationManifest.map((migration) => migration.tag)).toEqual(
            migrationJournal.entries.map((entry) => entry.tag),
        );
        expect(preservingMigrations.map((migration) => migration.version)).toEqual([
            8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
            30, 31, 32, 33, 34, 35, 36, 37, 38,
        ]);
        expect(CURRENT_SCHEMA_VERSION).toBe(PRESERVED_SCHEMA_VERSION + preservingMigrations.length);
    });

    it.each([
        {
            name: 'missing migration',
            tags: migrationManifest.slice(0, -1).map((migration) => migration.tag),
        },
        {
            name: 'out-of-order migration',
            tags: [
                migrationManifest[1].tag,
                migrationManifest[0].tag,
                ...migrationManifest.slice(2).map((migration) => migration.tag),
            ],
        },
        {
            name: 'duplicate migration',
            tags: [
                migrationManifest[0].tag,
                migrationManifest[0].tag,
                ...migrationManifest.slice(2).map((migration) => migration.tag),
            ],
        },
    ])('rejects a $name', ({ tags }) => {
        expect(() => assertMigrationManifestMatchesJournal(tags, migrationJournal)).toThrow(
            /migration manifest/i,
        );
    });
});
