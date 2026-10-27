import type { AgentMessageReceipt } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { StoredMessage } from './types';

/**
 * Why a Peer Message receipt changed status, so a `capacity` or `expired` receipt can be told apart after the fact:
 *
 * - `admitted`: accepted as `waiting` or `held`.
 * - `policy_refused` / `user_denied`: the receiver's policy refused it, or the user denied it while held.
 * - `user_approved`: the user approved a held message, which then waits for a pull.
 * - `pulled`: the receiver's pull reply reached it.
 * - `ttl_elapsed` / `held_expired`: its lifetime ran out while waiting, or while held (the approval window).
 * - `endpoint_retired`: the receiver or sender endpoint went away.
 * - `delivery_disabled`: the receiver's messaging became unavailable.
 * - `target_unavailable` / `cross_project`: the target could not be resolved or cannot take messages, or lives in another
 *   Project.
 * - `reply_depth_exceeded`, `pair_rate_limited`, `queue_full`, `pending_limit_reached`: the four `capacity` limits (reply
 *   chain depth, messages between one pair per window, the receiver's queue, and the Server-wide pending budget).
 */
export type AgentMessageTransitionReason =
    | 'admitted'
    | 'policy_refused'
    | 'user_denied'
    | 'user_approved'
    | 'pulled'
    | 'ttl_elapsed'
    | 'held_expired'
    | 'endpoint_retired'
    | 'delivery_disabled'
    | 'target_unavailable'
    | 'cross_project'
    | 'reply_depth_exceeded'
    | 'pair_rate_limited'
    | 'queue_full'
    | 'pending_limit_reached';

const WARN_STATUSES = new Set<AgentMessageReceipt['status']>([
    'capacity',
    'expired',
    'unavailable',
]);

/**
 * Writes one `agent_message.transitioned` record. Only opaque IDs, closed enums, and counts: the body never leaves the
 * registry. A failing logger must not change what send, wait, approve, or deny return, so a write error is dropped.
 */
export function logMessageTransition(
    logger: Pick<StructuredLogger, 'write'> | undefined,
    message: StoredMessage,
    previousStatus: AgentMessageReceipt['status'] | null,
    reason: AgentMessageTransitionReason,
    queueDepth: number,
    now: number,
): void {
    if (!logger) return;
    const { receipt } = message;
    try {
        logger.write(
            WARN_STATUSES.has(receipt.status) ? 'warn' : 'info',
            logEventCatalog.agentMessage.transitioned,
            {
                fields: {
                    messageId: receipt.messageId,
                    previousStatus,
                    status: receipt.status,
                    reason,
                    durationMs: Math.max(0, now - receipt.createdAt),
                    queueDepth,
                    replyDepth: message.depth,
                    hasReplyTo: receipt.replyTo !== undefined,
                    fromEndpointId: receipt.from.endpointId,
                    toEndpointId: receipt.to.endpointId,
                },
            },
        );
    } catch {
        // Best effort, like the receipt broadcasts.
    }
}
