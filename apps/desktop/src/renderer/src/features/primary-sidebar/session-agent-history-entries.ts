import type { SessionAgentHistoryEntry } from '@caxri/protocol';

/**
 * The card lists a Session's conversations only once one of them can be brought back. A Session whose every
 * conversation is still open in a Terminal would only repeat what its tabs already show.
 */
export function hasReopenableConversation(entries: readonly SessionAgentHistoryEntry[]): boolean {
    return entries.some((entry) => entry.terminalId === undefined);
}

/**
 * The conversations the context menu offers to bring back: those whose Terminal is gone, newest first as the Server
 * lists them. A still-open one is already a tab of the Session.
 */
export function reopenableConversations(
    entries: readonly SessionAgentHistoryEntry[],
): SessionAgentHistoryEntry[] {
    return entries.filter((entry) => entry.terminalId === undefined);
}
