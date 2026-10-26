import { randomUUID } from 'node:crypto';

/**
 * The third group of a prompt uuid Server Core delivered from its follow-up queue: version 8, RFC 9562's custom layout,
 * then Caxri's `c01`. A provider that echoes the id it was given in its own record (Claude Code's transcript uuid, Grok
 * Build's replayed `prompt_id`) but keeps no field that could carry the delivery uses the uuid itself as the mark
 * across a resume and a Server Core restart (#1610, #1705). Providers' own uuids are version 4 and never match.
 */
const QUEUED_PROMPT_UUID_GROUP = '8c01';

/**
 * The same mark for the hidden prompt a Chat sends on its own once a used-up plan limit resets (issue #2220), so a
 * history replay keeps it out of the timeline as the live Chat does.
 */
const USAGE_LIMIT_CONTINUE_UUID_GROUP = '8c02';

function markedUuid(group: string): string {
    const groups = randomUUID().split('-');
    groups[2] = group;
    return groups.join('-');
}

function uuidGroup(uuid: string): string | undefined {
    return uuid.split('-', 3)[2]?.toLowerCase();
}

/**
 * A fresh uuid; a `queued` one carries {@link QUEUED_PROMPT_UUID_GROUP}.
 */
export function queuedPromptUuid(delivery?: 'queued' | 'steered'): string {
    return delivery === 'queued' ? markedUuid(QUEUED_PROMPT_UUID_GROUP) : randomUUID();
}

/**
 * Whether `uuid` was made by {@link queuedPromptUuid} for a queued message.
 */
export function isQueuedPromptUuid(uuid: string): boolean {
    return uuidGroup(uuid) === QUEUED_PROMPT_UUID_GROUP;
}

/**
 * A fresh uuid for an automatic continuation after a usage limit reset.
 */
export function usageLimitContinuePromptUuid(): string {
    return markedUuid(USAGE_LIMIT_CONTINUE_UUID_GROUP);
}

/**
 * Whether `uuid` was made by {@link usageLimitContinuePromptUuid}.
 */
export function isUsageLimitContinuePromptUuid(uuid: string): boolean {
    return uuidGroup(uuid) === USAGE_LIMIT_CONTINUE_UUID_GROUP;
}
