/**
 * Queue metadata captured before an authenticated frame enters the ordered admission lane.
 */
export interface OrderedQueueTiming {
    enqueuedAt: number;
    queueDepth: number;
    /**
     * Set when the request waited in the connection's repository or background lane after ordered admission, so a long
     * `queueMs` names which lane held it: an earlier repository mutation or sweep rather than an ordinary ordered
     * write.
     */
    lane?: 'background' | 'repository';
    /**
     * The earlier request that held a lane for the longest part of this request's wait. Set only once the wait exceeded
     * the attribution floor, so it names the real owner of a long `queueMs` instead of leaving a reader to guess from
     * overlapping time windows.
     */
    blockedBy?: { method: string; overlapMs: number; requestId: string };
}

/**
 * Ordered-queue wait above this threshold escalates the per-request log to `warn`: it is the direct signature of
 * head-of-line blocking on the per-connection command queue, which the default `info` log level must surface.
 */
export const REQUEST_QUEUE_WARN_MS = 1_000;
/**
 * A wait this long is a visible hitch (a Session tab click that takes a quarter second to respond) but not yet a fault.
 * It is logged at `info`, which the default log level keeps, with the blocking request named, so a reported lag can be
 * traced without raising the log level and reproducing it.
 */
export const REQUEST_QUEUE_NOTICE_MS = 250;
/**
 * Queue wait plus handler time above this threshold also escalates to `warn`; the Desktop client gives up at 15s, so a
 * request this slow is about to become a user-visible timeout.
 */
export const REQUEST_TOTAL_WARN_MS = 5_000;
