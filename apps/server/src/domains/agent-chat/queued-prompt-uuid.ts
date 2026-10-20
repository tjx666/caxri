import { randomUUID } from 'node:crypto';

/**
 * The third group of a prompt uuid Server Core delivered from its follow-up queue: version 8, RFC 9562's custom layout,
 * then Caxri's `c01`. A provider that echoes the id it was given in its own record (Claude Code's transcript uuid, Grok
 * Build's replayed `prompt_id`) but keeps no field that could carry the delivery uses the uuid itself as the mark
 * across a resume and a Server Core restart (#1610, #1705). Providers' own uuids are version 4 and never match.
 */
const QUEUED_PROMPT_UUID_GROUP = '8c01';

/**
 * A fresh uuid; a `queued` one carries {@link QUEUED_PROMPT_UUID_GROUP}.
 */
export function queuedPromptUuid(delivery?: 'queued' | 'steered'): string {
    const uuid = randomUUID();
    if (delivery !== 'queued') return uuid;
    const groups = uuid.split('-');
    groups[2] = QUEUED_PROMPT_UUID_GROUP;
    return groups.join('-');
}

/**
 * Whether `uuid` was made by {@link queuedPromptUuid} for a queued message.
 */
export function isQueuedPromptUuid(uuid: string): boolean {
    return uuid.split('-', 3)[2]?.toLowerCase() === QUEUED_PROMPT_UUID_GROUP;
}
