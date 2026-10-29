import type {
    AgentProvider,
    AgentUsageGuard,
    TerminalRecord,
    TerminalSubagentSummary,
} from '@caxri/protocol';

/**
 * Adds what only a running Server Core knows to a stored Terminal row before any Client sees it: the live Agent
 * subphase, the time a usage-limit wait continues, a PTY Agent's weekly usage guard, the PTY's process id, and a Chat's
 * persisted subagent summaries (read from SQLite, so projecting them starts no provider the way `agentChat.read`
 * does).
 */
export function createLiveTerminalRecord(
    coordinator: { agentOperation(terminalId: string): TerminalRecord['agentOperation'] },
    terminals: { processId(terminalId: string): number | undefined },
    /**
     * The persisted summaries; injected so this module does not import the Chat domain (which depends on Terminal and
     * Workbench).
     */
    summaries: { list(terminalId: string): readonly TerminalSubagentSummary[] },
    /**
     * The Chat usage-limit waits, injected for the same reason as `summaries`.
     */
    usageLimitWaits: { waitingAt(terminalId: string): number | undefined },
    /**
     * The weekly usage guard of a provider, injected for the same reason; projected onto PTY Agent Terminals only.
     */
    usageGuards: { current(provider: AgentProvider): AgentUsageGuard | undefined },
): (terminal: TerminalRecord) => TerminalRecord {
    return (terminal) => {
        const subagents = terminal.surface === 'chat' ? summaries.list(terminal.id) : undefined;
        const guard =
            terminal.surface !== 'chat' && terminal.provider
                ? usageGuards.current(terminal.provider)
                : undefined;
        return {
            ...terminal,
            ...(guard && {
                usageGuard: { usedPercent: guard.usedPercent, resetsAt: guard.resetsAt },
            }),
            ...(subagents && subagents.length > 0 && { subagents: [...subagents] }),
            agentOperation: coordinator.agentOperation(terminal.id),
            usageLimitWaitAt: usageLimitWaits.waitingAt(terminal.id),
            processId: terminals.processId(terminal.id),
        };
    };
}
