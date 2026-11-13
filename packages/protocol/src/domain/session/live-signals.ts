import { z } from 'zod';

import { identifierSchema } from '../identifiers.js';

/**
 * When a Session counts as running hot: its whole live footprint (every PTY Terminal's process tree plus every Chat
 * provider's) has stayed at or above `cpuPercent` for `sustainMs`. It cools once the reading drops below
 * `coolCpuPercent` for `coolMs`. The gap between the two lines keeps a tree hovering around one core from flickering.
 *
 * One core is far below the resource alert's 300% on purpose: several Sessions each holding a core spin the fans
 * without any single one crossing the alert, and the sidebar marker is how the user finds them. It never notifies; the
 * alert stays the one interrupting signal for a runaway tree.
 */
export const SESSION_HEAT_THRESHOLDS = {
    coolCpuPercent: 70,
    coolMs: 20_000,
    cpuPercent: 100,
    sustainMs: 60_000,
} as const;

const sessionHeatSchema = z.strictObject({
    /**
     * The latest summed `ps` `%cpu` across the Session's process trees; can exceed 100.
     */
    cpuPercent: z.number().nonnegative(),
    /**
     * When the reading first crossed {@link SESSION_HEAT_THRESHOLDS.cpuPercent} in this episode (epoch ms).
     */
    since: z.number().int().nonnegative(),
});

export type SessionHeat = z.infer<typeof sessionHeatSchema>;

/**
 * A macOS Keychain access dialog that a process of this Session raised and the user has not answered yet. Attribution
 * walks the requesting PID's parent chain up to a Terminal or Chat root Caxri started, so a prompt from an Agent's
 * subprocess (a CLI the Agent ran) lands on the Session that ran it.
 */
const sessionKeychainPromptSchema = z.strictObject({
    /**
     * The requesting process's command line, shortened for display. Shown in the row's tooltip only; never logged.
     */
    command: z.string().max(512),
    pid: z.number().int().positive(),
    /**
     * When securityd displayed the dialog (epoch ms).
     */
    since: z.number().int().nonnegative(),
});

export type SessionKeychainPrompt = z.infer<typeof sessionKeychainPromptSchema>;

/**
 * Live, machine-observed facts about one Session that its record does not carry. Absent fields mean "nothing to show".
 */
const sessionSignalSchema = z.strictObject({
    heat: sessionHeatSchema.optional(),
    keychainPrompt: sessionKeychainPromptSchema.optional(),
});

export type SessionSignal = z.infer<typeof sessionSignalSchema>;

/**
 * Every Session with at least one live signal, keyed by Session ID. Small by construction: only hot Sessions and
 * Sessions with an open Keychain dialog appear.
 */
export const sessionSignalsSchema = z.strictObject({
    sessions: z.record(identifierSchema, sessionSignalSchema),
});

export type SessionSignals = z.infer<typeof sessionSignalsSchema>;
