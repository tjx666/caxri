import type { TerminalRecord } from '@caxri/protocol';

/**
 * Groups already-ordered Terminal records by Session so Session state reads can reuse a Terminal list the caller
 * fetched instead of querying the ordering again.
 */
export function terminalIdsBySession(
    terminalRecords: readonly TerminalRecord[],
): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    for (const terminal of terminalRecords) {
        const terminalIds = grouped.get(terminal.sessionId);
        if (terminalIds) terminalIds.push(terminal.id);
        else grouped.set(terminal.sessionId, [terminal.id]);
    }
    return grouped;
}
