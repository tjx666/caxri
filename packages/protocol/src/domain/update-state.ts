import { z } from 'zod';

const updateVersionFields = {
    currentVersion: z.string().min(1).max(64),
    version: z.string().min(1).max(64),
    fileName: z.string().min(1).max(255),
};

/**
 * Main-owned update state exposed to the Renderer without leaking download paths or URLs.
 */
export const updateStateSchema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('idle'), currentVersion: updateVersionFields.currentVersion }),
    z.object({ status: z.literal('checking'), currentVersion: updateVersionFields.currentVersion }),
    z.object({
        status: z.literal('unavailable'),
        currentVersion: updateVersionFields.currentVersion,
        reason: z.string().min(1).max(1_024),
        /**
         * Set when GitHub's rate limiter, rather than a missing release feed or an unpackaged build, is what makes the
         * check unavailable. Unlike a Project Status budget, where the retry a row would offer is exactly the request
         * the limiter is refusing, a manual update check deliberately bypasses this window (`UpdateService.check({
         * manual: true })`), so the UI keeps offering the action instead of disabling it.
         */
        rateLimited: z.boolean().optional(),
        /**
         * Epoch ms when the automatic check stops skipping the network call, from GitHub's `retry-after` or
         * `x-ratelimit-reset` hint. Present only alongside `rateLimited`, and only when GitHub sent a deadline; a
         * consumer must still compare it against the current clock, because a state read outlives its own pause.
         */
        retryAt: z.number().int().positive().optional(),
    }),
    z.object({
        status: z.literal('up-to-date'),
        currentVersion: updateVersionFields.currentVersion,
    }),
    z.object({
        status: z.literal('available'),
        ...updateVersionFields,
        /**
         * `true` once this app process has already offered this version to a window: the Renderer calls
         * `updates.acknowledge` as soon as it raises the notification or opens the update dialog. It exists so a window
         * reload, or a download the user cancelled back to `available`, re-reads the same state without producing a
         * second prompt, while the next launch starts over. Nothing here is persisted: that is what separates `Close`
         * ("not now", this process only) from `Skip this version` (`updates.skippedVersion`).
         */
        announced: z.boolean().optional(),
    }),
    z.object({
        status: z.literal('downloading'),
        ...updateVersionFields,
        receivedBytes: z.number().int().nonnegative(),
        totalBytes: z.number().int().positive().optional(),
    }),
    z.object({ status: z.literal('ready'), ...updateVersionFields }),
    z.object({
        status: z.literal('error'),
        currentVersion: updateVersionFields.currentVersion,
        action: z.enum(['check', 'download', 'open']),
        failureKind: z.enum(['network', 'integrity', 'other']),
        message: z.string().min(1).max(2_048),
        version: updateVersionFields.version.optional(),
        fileName: updateVersionFields.fileName.optional(),
    }),
]);

export type UpdateState = z.infer<typeof updateStateSchema>;
