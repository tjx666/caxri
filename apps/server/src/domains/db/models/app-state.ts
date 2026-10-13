import {
    auxiliaryWindowStateSchema,
    CaxriError,
    commanderAgentSchema,
    commanderHandoverSchema,
    identifierSchema,
    persistedWindowStateSchema,
} from '@caxri/protocol';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { CaxriDrizzleDatabase } from '../connection';
import { appState } from '../schema';

const appStateValueSchemas = {
    lastSelectedProjectId: identifierSchema.nullable(),
    lastSelectedSessionId: identifierSchema.nullable(),
    windowBounds: persistedWindowStateSchema.shape.bounds,
    windowState: persistedWindowStateSchema.pick({
        isMaximized: true,
        isFullScreen: true,
    }),
    /**
     * The Agent Commander and Process Explorer windows' cross-restart bounds and open state, see
     * `auxiliaryWindowStateSchema`. Kept as one row since Main persists both windows together at quit.
     */
    auxiliaryWindowState: auxiliaryWindowStateSchema,
    activeThemeId: z.string().min(1),
    externalDelegationSessions: z.record(z.string(), identifierSchema),
    /**
     * The Agent Commander's system rows and the Sessions it created in user Projects. See `commander-rows.ts`.
     */
    agentCommander: z.strictObject({
        projectId: identifierSchema,
        sessionId: identifierSchema,
        terminalId: identifierSchema.optional(),
        sessionIds: z.array(identifierSchema).max(1_000),
    }),
    /**
     * The Agent CLI the user chose for the Agent Commander. Its own cell rather than a field of `agentCommander`, whose
     * writers rebuild that record from its rows: the choice must survive every one of them, and a Commander Terminal
     * created later (first launch, or after its row was lost) starts with it.
     */
    commanderAgent: commanderAgentSchema,
    /**
     * The user's hand-overs of Sessions to the Agent Commander, at most one per managed Session. See
     * `commander/handover.ts`.
     */
    commanderHandovers: z.array(commanderHandoverSchema).max(1_000),
} as const;

export type AppStateKey = keyof typeof appStateValueSchemas;
export type AppStateValue<K extends AppStateKey> = z.infer<(typeof appStateValueSchemas)[K]>;

/**
 * Parses one `app_state` JSON cell. Malformed JSON or a shape mismatch is VALIDATION, not `as T`.
 */
export function parseAppStateValue<K extends AppStateKey>(
    key: K,
    valueJson: string,
): AppStateValue<K> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(valueJson);
    } catch {
        throw new CaxriError('VALIDATION', `Invalid app state JSON for ${key}`);
    }
    const result = appStateValueSchemas[key].safeParse(parsed);
    if (!result.success) throw new CaxriError('VALIDATION', `Invalid app state value for ${key}`);
    return result.data as AppStateValue<K>;
}

/**
 * Pure key/value CRUD over the `app_state` table.
 */
export class AppStateModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    get<K extends AppStateKey>(key: K): AppStateValue<K> | undefined {
        const row = this.database
            .select({ valueJson: appState.valueJson })
            .from(appState)
            .where(eq(appState.key, key))
            .get();
        return row ? parseAppStateValue(key, row.valueJson) : undefined;
    }

    set<K extends AppStateKey>(key: K, value: AppStateValue<K>): void {
        const valueJson = JSON.stringify(value);
        this.database
            .insert(appState)
            .values({ key, valueJson })
            .onConflictDoUpdate({ target: appState.key, set: { valueJson } })
            .run();
    }
}
