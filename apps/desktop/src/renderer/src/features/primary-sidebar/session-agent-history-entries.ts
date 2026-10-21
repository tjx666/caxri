import type { SessionAgentHistoryEntry } from '@caxri/protocol';

/**
 * The card lists a Session's conversations only once one of them can be brought back. A Session whose every
 * conversation is still open in a Terminal would only repeat what its tabs already show.
 */
export function hasReopenableConversation(entries: readonly SessionAgentHistoryEntry[]): boolean {
    return entries.some((entry) => entry.terminalId === undefined);
}
