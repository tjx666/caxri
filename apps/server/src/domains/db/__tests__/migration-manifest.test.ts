import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    assertMigrationManifestMatchesJournal,
    BASELINE_SCHEMA_VERSION,
    CURRENT_SCHEMA_VERSION,
    migrationManifest,
    migrationsAfterBaseline,
} from '../migrations/manifest';
import migrationJournal from '../migrations/meta/_journal.json';

const journal = (tags: readonly string[]) => ({
    dialect: 'sqlite',
    entries: tags.map((tag, index) => ({ idx: index, tag })),
});

describe('migration manifest', () => {
    /**
     * The updater compares this Info.plist value between the installed and the staged bundle to warn before an update
     * rebuilds the database (`willStagedUpdateResetData`), so it must move with every new baseline.
     */
    it('stamps the baseline into the packaged Info.plist', () => {
        const manifest = JSON.parse(
            readFileSync(resolve(import.meta.dirname, '../../../../../../package.json'), 'utf8'),
        ) as { build: { mac: { extendInfo: Record<string, unknown> } } };
        expect(manifest.build.mac.extendInfo.CaxriSchemaBaseline).toBe(BASELINE_SCHEMA_VERSION);
    });

    it('matches every Drizzle journal entry in order and derives schema versions', () => {
        expect(migrationManifest.map((migration) => migration.tag)).toEqual(
            migrationJournal.entries.map((entry) => entry.tag),
        );
        expect(migrationManifest[0].tag).toBe('0000_baseline');
        expect(migrationsAfterBaseline.map((migration) => migration.version)).toEqual(
            migrationsAfterBaseline.map((_, index) => BASELINE_SCHEMA_VERSION + index + 1),
        );
        expect(CURRENT_SCHEMA_VERSION).toBe(
            BASELINE_SCHEMA_VERSION + migrationsAfterBaseline.length,
        );
    });

    it.each([
        { name: 'missing migration', tags: ['0000_baseline'] },
        { name: 'out-of-order migration', tags: ['0001_next', '0000_baseline'] },
        { name: 'duplicate migration', tags: ['0000_baseline', '0000_baseline'] },
    ])('rejects a $name', ({ tags }) => {
        expect(() =>
            assertMigrationManifestMatchesJournal(tags, journal(['0000_baseline', '0001_next'])),
        ).toThrow(/migration manifest/i);
    });
});
