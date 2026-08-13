import { createHash } from 'node:crypto';

import type { AgentInboundPolicy } from '../../shared/ipc/agent-inbox-contract';
import type {
    AgentEndpointRef,
    AgentPermissionClass,
} from '../../shared/ipc/agent-endpoint-contract';

export const MAX_WAITING_PER_ENDPOINT = 50;
export const MAX_HELD_PER_ENDPOINT = 100;
export const MAX_PENDING_MESSAGES = 1_024;
export const MAX_PENDING_BYTES = 4 * 1024 * 1024;
export const MAX_RECEIPTS = 4_096;
export const DUPLICATE_WINDOW_MS = 30_000;
export const LOOP_WINDOW_MS = 5 * 60 * 1_000;
export const MAX_PAIR_MESSAGES_PER_WINDOW = 16;
export const MAX_REPLY_DEPTH = 8;

export function endpointKey(ref: AgentEndpointRef): string {
    return `${ref.hostId}:${ref.endpointId}:${ref.generation}`;
}

export function refsEqual(left: AgentEndpointRef, right: AgentEndpointRef): boolean {
    return endpointKey(left) === endpointKey(right);
}

export function agentMessageDigest(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function boundedPreview(body: string): string {
    return [...body].slice(0, 240).join('');
}

/** The complete auto-policy matrix is intentionally small enough to exhaustively regression test. */
export function decideInboundStatus(
    policy: AgentInboundPolicy,
    sender: AgentPermissionClass,
    receiver: AgentPermissionClass,
): 'waiting' | 'held' | 'refused' {
    if (policy === 'refuse') return 'refused';
    if (policy === 'hold') return 'held';
    if (policy === 'accept') return 'waiting';
    return sender !== 'unknown' && sender === receiver ? 'waiting' : 'held';
}
