import { z } from 'zod';

/**
 * Which Linux inotify ceiling a native watch hit. `watch-limit` is `fs.inotify.max_user_watches` (one watch per watched
 * directory, so a large Project exhausts it); `instance-limit` is `fs.inotify.max_user_instances` (every program the
 * account runs that watches files holds one). Both are per-account kernel settings only an administrator can raise.
 */
export const fileWatchLimitSchema = z.enum(['watch-limit', 'instance-limit']);

export type FileWatchLimit = z.infer<typeof fileWatchLimitSchema>;

/**
 * Closed reason set for `watch_hub.subscribe_failed` and `watch_hub.fallback`: a kernel limit the operator can raise,
 * or anything else (a removed root, a permission error, the hub's own capacity gate).
 */
export type FileWatchFailureReason = FileWatchLimit | 'other';

/**
 * `raised` when a native watch degrades to polling because of a kernel limit, `cleared` once no watch is degraded for
 * that cause anymore (native watching came back, or the degraded watches were disposed), so a client can retract the
 * notice.
 */
export const fileWatchLimitAlertSchema = z.discriminatedUnion('state', [
    z.object({ state: z.literal('raised'), reason: fileWatchLimitSchema }),
    z.object({ state: z.literal('cleared') }),
]);

export type FileWatchLimitAlert = z.infer<typeof fileWatchLimitAlertSchema>;
