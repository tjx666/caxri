import type { TerminalRecord, TerminalSubagentSummary } from '@caxri/protocol';

/**
 * Adds what only a running Server Core knows to a stored Terminal row before any Client sees it: the live Agent
 * subphase, the PTY's process id, and a Chat's persisted subagent summaries (read from SQLite, so projecting them
 * starts no provider the way `agentChat.read` does).
 */
export function createLiveTerminalRecord(
    coordinator: { agentOperation(terminalId: string): TerminalRecord['agentOperation'] },
    terminals: { processId(terminalId: string): number | undefined },
    /**
     * The persisted summaries; injected so this module does not import the Chat domain (which depends on Terminal and
     * Workbench).
     */
    summaries: { list(terminalId: string): readonly TerminalSubagentSummary[] },
): (terminal: TerminalRecord) => TerminalRecord {
    return (terminal) => {
        const subagents = terminal.surface === 'chat' ? summaries.list(terminal.id) : undefined;
        return {
            ...terminal,
            ...(subagents && subagents.length > 0 && { subagents: [...subagents] }),
            agentOperation: coordinator.agentOperation(terminal.id),
            processId: terminals.processId(terminal.id),
        };
    };
}
