import { z } from 'zod';

const updateVersionFields = {
    currentVersion: z.string().min(1).max(64),
    version: z.string().min(1).max(64),
    fileName: z.string().min(1).max(255),
};

/**
 * The release page for the version in play, from the release's `html_url`. Optional because the Acceptance fixture and
 * older cached states have no page to offer; the Renderer falls back to the version's tag page.
 */
const releaseUrlField = { releaseUrl: z.url().max(2_048).optional() };

/**
 * Set on every state while this launch is the first run after an app update, carrying the version that was replaced.
 * The Renderer raises the one-time "Updated to Caxri X" notice from it and then calls `updates.acknowledge`, after
 * which Main stops stamping it, so a window reload or a second window never repeats the notice.
 */
const updatedFromField = { updatedFrom: z.string().min(1).max(64).optional() };

/**
 * `true` once this app process has already offered this version to a window: the Renderer calls `updates.acknowledge`
 * as soon as it raises the notification or opens the update dialog. It exists so a window reload, or a download the
 * user cancelled back to `available`, re-reads the same state without producing a second prompt, while the next launch
 * starts over. Nothing here is persisted: that is what separates `Close` ("not now", this process only) from `Skip this
 * version` (`updates.skippedVersion`).
 */
const announcedField = { announced: z.boolean().optional() };

/**
 * Main-owned update state exposed to the Renderer without leaking download paths or URLs.
 */
export const updateStateSchema = z.discriminatedUnion('status', [
    z.object({
        status: z.literal('idle'),
        currentVersion: updateVersionFields.currentVersion,
        ...updatedFromField,
    }),
    z.object({
        status: z.literal('checking'),
        currentVersion: updateVersionFields.currentVersion,
        ...updatedFromField,
    }),
    z.object({
        status: z.literal('unavailable'),
        currentVersion: updateVersionFields.currentVersion,
        ...updatedFromField,
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
        ...updatedFromField,
    }),
    z.object({
        status: z.literal('available'),
        ...updateVersionFields,
        ...releaseUrlField,
        ...updatedFromField,
        ...announcedField,
    }),
    z.object({
        status: z.literal('downloading'),
        ...updateVersionFields,
        ...releaseUrlField,
        ...updatedFromField,
        receivedBytes: z.number().int().nonnegative(),
        totalBytes: z.number().int().positive().optional(),
    }),
    z.object({
        status: z.literal('ready'),
        ...updateVersionFields,
        ...releaseUrlField,
        ...updatedFromField,
        ...announcedField,
        /**
         * How this verified update reaches the disk. `restart`: Main already unpacked the new app next to the profile
         * and replaces the installed bundle itself on the next restart or quit. `manual`: this install cannot be
         * replaced in place (not in a writable folder, running from a disk image, or unpacking failed), so the user
         * opens the DMG and drags the app, as before.
         */
        installMode: z.enum(['restart', 'manual']),
        /**
         * Set when the staged update starts from a newer database baseline than this build, so installing it clears the
         * Project and Session list (the clean-install cutoff; Project folders and user files are untouched). Main then
         * never installs it on an ordinary quit and asks before `Restart to Update`, offering an export first. Only a
         * `restart` install can be inspected ahead of time; a `manual` one never carries it.
         */
        resetsData: z.literal(true).optional(),
    }),
    z.object({
        status: z.literal('error'),
        currentVersion: updateVersionFields.currentVersion,
        ...updatedFromField,
        action: z.enum(['check', 'download', 'install', 'open']),
        failureKind: z.enum(['network', 'integrity', 'other']),
        message: z.string().min(1).max(2_048),
        version: updateVersionFields.version.optional(),
        fileName: updateVersionFields.fileName.optional(),
    }),
]);

export type UpdateState = z.infer<typeof updateStateSchema>;
