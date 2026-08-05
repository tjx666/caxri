import type Database from 'better-sqlite3';

/** Pure key/value CRUD over the `app_state` table. */
export class AppStateStore {
    constructor(private readonly database: Database.Database) {}

    get<T>(key: string): T | undefined {
        const row = this.database
            .prepare('SELECT value_json FROM app_state WHERE key = ?')
            .get(key) as { value_json: string } | undefined;
        return row ? (JSON.parse(row.value_json) as T) : undefined;
    }

    set(key: string, value: unknown): void {
        this.database
            .prepare(
                `INSERT INTO app_state (key, value_json) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
            )
            .run(key, JSON.stringify(value));
    }
}
