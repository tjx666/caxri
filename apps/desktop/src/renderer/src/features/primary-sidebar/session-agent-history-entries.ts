import type { SessionAgentHistoryEntry } from '@caxri/protocol';

/**
 * The conversations the context menu offers to bring back: those whose Terminal is gone, newest first as the Server
 * lists them. A still-open one is already a tab of the Session.
 */
export function reopenableConversations(
    entries: readonly SessionAgentHistoryEntry[],
): SessionAgentHistoryEntry[] {
    return entries.filter((entry) => entry.terminalId === undefined);
}
