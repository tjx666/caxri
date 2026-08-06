import { eq } from 'drizzle-orm';

import { appState } from './schema';
import type { CaxriDrizzleDatabase } from './sqlite';

/** Pure key/value CRUD over the `app_state` table. */
export class AppStateStore {
    constructor(private readonly db: CaxriDrizzleDatabase) {}

    get<T>(key: string): T | undefined {
        const row = this.db
            .select({ valueJson: appState.valueJson })
            .from(appState)
            .where(eq(appState.key, key))
            .get();
        return row ? (JSON.parse(row.valueJson) as T) : undefined;
    }

    set(key: string, value: unknown): void {
        const valueJson = JSON.stringify(value);
        this.db
            .insert(appState)
            .values({ key, valueJson })
            .onConflictDoUpdate({ target: appState.key, set: { valueJson } })
            .run();
    }
}
