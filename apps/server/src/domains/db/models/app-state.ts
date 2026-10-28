import {
    agentChatAutoContinueSchema,
    agentChatHandoffSchema,
    agentProviderSchema,
    agentUsageGuardSchema,
    agentUsageLimitWindowSchema,
    airplaneModeStateSchema,
    auxiliaryWindowStateSchema,
    botAgentSchema,
    botHandoverSchema,
    CaxriError,
    identifierSchema,
    persistedWindowStateSchema,
    windowKeySchema,
    windowOpenSessionsSchema,
} from '@caxri/protocol';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { CaxriDrizzleDatabase } from '../connection';
import { appState } from '../schema';

const appStateValueSchemas = {
    lastSelectedProjectId: identifierSchema.nullable(),
    /**
     * Each Workbench window's Open Session, keyed by the window key Desktop Main mints. There is no global "selected
     * Session": two windows each show their own. IDs live inside JSON where no foreign key reaches them, so
     * `reconcileOpenSessions` prunes them on archive, deletion, and Project hiding.
     */
    openSessionsByWindow: z.record(windowKeySchema, windowOpenSessionsSchema),
    windowBounds: persistedWindowStateSchema.shape.bounds,
    windowState: persistedWindowStateSchema.pick({
        isMaximized: true,
        isFullScreen: true,
    }),
    /**
     * Caxri Bot and Process Explorer windows' cross-restart bounds and open state, see `auxiliaryWindowStateSchema`.
     * Kept as one row since Main persists both windows together at quit.
     */
    auxiliaryWindowState: auxiliaryWindowStateSchema,
    activeThemeId: z.string().min(1),
    externalDelegationSessions: z.record(z.string(), identifierSchema),
    /**
     * Caxri Bot's system rows and the Sessions it created in user Projects. See `bot-rows.ts`.
     */
    caxriBot: z.strictObject({
        projectId: identifierSchema,
        sessionId: identifierSchema,
        terminalId: identifierSchema.optional(),
        sessionIds: z.array(identifierSchema).max(1_000),
    }),
    /**
     * The Agent CLI the user chose for Caxri Bot. Its own cell rather than a field of `caxriBot`, whose writers rebuild
     * that record from its rows: the choice must survive every one of them, and a Caxri Bot Terminal created later
     * (first launch, or after its row was lost) starts with it.
     */
    botAgent: botAgentSchema,
    /**
     * The user's hand-overs of Sessions to Caxri Bot, at most one per managed Session. See `bot/handover.ts`.
     */
    botHandovers: z.array(botHandoverSchema).max(1_000),
    /**
     * Mobile gateway preferences beside `mobile_devices`: the owner left access on (the next Server start reopens the
     * gateway without another click) and the last port it listened on.
     */
    /**
     * Airplane Mode survives a restart: its dialog stays up and the Sessions it parked stay offered for resume. See
     * `session/airplane-mode.ts`.
     */
    airplaneMode: airplaneModeStateSchema.omit({ compaction: true }),
    mobileGateway: z.strictObject({
        accessEnabled: z.literal(true).optional(),
        preferredPort: z.number().int().min(1).max(65_535).optional(),
    }),
    /**
     * Each provider account's weekly usage guard, so a restart neither lifts it early nor grants a second hand-off in
     * the same window. See `usage/usage-guard.ts`.
     */
    agentUsageGuards: z
        .array(
            agentUsageGuardSchema.extend({
                armedAt: z.number().int().positive(),
                /**
                 * The Chat that spent the hand-off lease, and what it produced.
                 */
                handoffTerminalId: identifierSchema.optional(),
                document: agentChatHandoffSchema.optional(),
            }),
        )
        .max(8),
    /**
     * When the user last dismissed each provider's plan pace reminder, from any Client, so the reminder stays hidden
     * for the rest of the day on Desktop and the phone alike. See `usage/usage-notice-dismissals.ts`.
     */
    planPaceDismissals: z.partialRecord(agentProviderSchema, z.number().int().positive()),
    /**
     * When the user last dismissed each provider's credits notice, from any Client, so it stays hidden for a day. See
     * `usage/usage-notice-dismissals.ts`.
     */
    creditsNoticeDismissals: z.partialRecord(agentProviderSchema, z.number().int().positive()),
    /**
     * Each Chat's automatic continuation after its latest used-up plan limit (issue #2220), so a wait survives a Server
     * Core restart and its notice comes back after a history replay that lacks it. At most one per Chat Terminal; see
     * `agent-chat/continuation/chat-usage-limit-waits.ts`.
     */
    agentChatUsageLimitWaits: z
        .array(
            z.strictObject({
                terminalId: identifierSchema,
                turnId: z.string().min(1).max(200),
                provider: agentProviderSchema,
                window: agentUsageLimitWindowSchema,
                resetsAt: z.number().int().positive().optional(),
                /**
                 * The failed turn's notice text, so a replay that dropped the notice can show it again.
                 */
                message: z.string().max(2_000),
                failedAt: z.number().int().positive(),
                /**
                 * Automatic continuations into this limit so far, counting the one this record waits for.
                 */
                attempt: z.number().int().min(1).max(100),
                autoContinue: agentChatAutoContinueSchema,
            }),
        )
        .max(1_000),
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
