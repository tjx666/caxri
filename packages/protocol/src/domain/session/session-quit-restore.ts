import { z } from 'zod';

import { identifierSchema } from '../identifiers.js';

/**
 * One Session whose live work the last quit stopped: the PTYs it ended, and whether the Session's Agent was still
 * working, so the restore can tell it to continue.
 */
const quitStoppedSessionSchema = z.strictObject({
    sessionId: identifierSchema,
    terminalIds: z.array(identifierSchema).max(64),
    shouldContinue: z.boolean(),
});

/**
 * What the last quit's "Stop Tasks" ended, kept until `session.restoreQuitStopped` relaunches it or the next quit that
 * stops work replaces it. See docs/session-quit-restore.md.
 */
export const quitStoppedSessionsSchema = z.strictObject({
    stoppedAt: z.number().int().positive(),
    /**
     * Set when Restart to Update (on the computer or from a paired phone) wrote the record: the next Server Core start
     * restores it on its own instead of offering it, since the user asked for an immediate restart.
     */
    restartedForUpdate: z.literal(true).optional(),
    sessions: z.array(quitStoppedSessionSchema).max(1_000),
});
export type QuitStoppedSessions = z.infer<typeof quitStoppedSessionsSchema>;

/**
 * Why `terminal.terminateAll` runs. `serverStop` (a quit's "Quit and Stop Tasks" or a Host Environment's Stop Server)
 * records what it stopped for a later restore; `update` (Restart to Update) records it for the next start to restore on
 * its own; `windowClose` (Terminate and Close) keeps the Server running and records nothing.
 */
export const terminateAllReasonSchema = z.enum(['serverStop', 'update', 'windowClose']);

export const sessionRestoreQuitStoppedResultSchema = z.object({
    /**
     * Sessions relaunched, including those whose Agent was told to continue.
     */
    restored: z.number().int().nonnegative(),
    /**
     * Recorded Sessions skipped because they were deleted or archived since the quit, or failed to relaunch.
     */
    skipped: z.number().int().nonnegative(),
});
export type SessionRestoreQuitStoppedResult = z.infer<typeof sessionRestoreQuitStoppedResultSchema>;

export const sessionQuitStoppedCountResultSchema = z.object({
    /**
     * Recorded Sessions a restore would still relaunch: those deleted or archived since the quit are left out.
     */
    count: z.number().int().nonnegative(),
    /**
     * When the quit stopped them, so the launch notice can say how long ago and stop offering a stale restore. Absent
     * when there is nothing to restore.
     */
    stoppedAt: z.number().int().positive().optional(),
});
