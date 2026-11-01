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
    sessions: z.array(quitStoppedSessionSchema).max(1_000),
});
export type QuitStoppedSessions = z.infer<typeof quitStoppedSessionsSchema>;

/**
 * Why `terminal.terminateAll` runs. Only `serverStop` (a quit's "Quit and Stop Tasks", Restart to Update, or a Host
 * Environment's Stop Server) records what it stopped for a later restore; `windowClose` (Terminate and Close) keeps the
 * Server running and records nothing.
 */
export const terminateAllReasonSchema = z.enum(['serverStop', 'windowClose']);

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
