import { z } from 'zod';

import { identifierSchema } from '../identifiers.js';

/**
 * Where Airplane Mode stands. `compacting` interrupts the running turns, then waits for the native compactions it
 * submitted, `parking` stops every Agent, `on` holds them stopped until the user resumes, and `resuming` relaunches the
 * Sessions the user picked.
 */
const airplaneModePhaseSchema = z.enum(['off', 'compacting', 'parking', 'on', 'resuming']);

export const airplaneModeStateSchema = z.object({
    phase: airplaneModePhaseSchema,
    /**
     * When the user entered Airplane Mode; absent while it is off.
     */
    enteredAt: z.number().int().nonnegative().optional(),
    /**
     * Progress of the compaction wait: how many submitted compactions are still running, and when the wait gives up.
     */
    compaction: z
        .object({
            submitted: z.number().int().nonnegative(),
            pending: z.number().int().nonnegative(),
            deadlineAt: z.number().int().nonnegative(),
        })
        .optional(),
    /**
     * Sessions whose Agents Airplane Mode stopped, in the order they were parked. Resuming offers exactly these.
     */
    parkedSessionIds: z.array(identifierSchema).max(1_000),
    /**
     * Sessions whose Agent was still working when the user entered (a running or waiting turn, a background subagent,
     * or a background command). Resuming one of them also tells its Agent to continue; an idle Session only
     * relaunches.
     */
    continueSessionIds: z.array(identifierSchema).max(1_000).default([]),
});

export type AirplaneModePhase = z.infer<typeof airplaneModePhaseSchema>;
export type AirplaneModeState = z.infer<typeof airplaneModeStateSchema>;
