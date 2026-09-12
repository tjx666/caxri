import { describe, expect, it } from 'vitest';

import { assertMigrationSqlOmitsForeignKeysPragma } from '../connection';
import { migrationManifest } from '../migrations/manifest';

describe('migration SQL foreign_keys pragma guard', () => {
    it('accepts every bundled migration', () => {
        for (const migration of migrationManifest)
            expect(() => assertMigrationSqlOmitsForeignKeysPragma(migration.sql)).not.toThrow();
    });

    it('rejects PRAGMA foreign_keys in migration SQL', () => {
        expect(() =>
            assertMigrationSqlOmitsForeignKeysPragma(
                'PRAGMA foreign_keys=OFF;\nCREATE TABLE t (id text);',
            ),
        ).toThrow(/create-copy-drop-rename/i);
        expect(() => assertMigrationSqlOmitsForeignKeysPragma('PRAGMA foreign_keys = ON;')).toThrow(
            /PRAGMA foreign_keys/i,
        );
    });
});
