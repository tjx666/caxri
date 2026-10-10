import * as drizzleKitApi from 'drizzle-kit/api';

/**
 * The parts of a drizzle-kit SQLite snapshot the migration tests read or edit. drizzle-kit 0.31 declares
 * `DrizzleSQLiteSnapshotJSON` through zod 3 generics while the workspace resolves zod 4, so the published types
 * collapse to error types.
 */
export interface SqliteSnapshot {
    id: string;
    tables: Record<
        string,
        {
            checkConstraints: Record<string, { name: string; value: string }>;
            columns: Record<string, unknown>;
        }
    >;
    views: Record<string, unknown>;
}

/**
 * Re-typed view of the two `drizzle-kit/api` functions the migration tests call; see {@link SqliteSnapshot} for why.
 */
interface SqliteMigrationApi {
    generateSQLiteDrizzleJson(
        imports: Record<string, unknown>,
        previousId?: string,
    ): Promise<SqliteSnapshot>;
    generateSQLiteMigration(previous: SqliteSnapshot, current: SqliteSnapshot): Promise<string[]>;
}

export const drizzleKit = drizzleKitApi as unknown as SqliteMigrationApi;
