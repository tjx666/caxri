import type { ServerEvent, TerminalRecord } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { AgentCoordinator } from './agents';
import type { CaxriDatabase } from './db';
import type { DomainHandlers } from './domain-services';
import type { TerminalManager, TerminalWorkingDirectoryIdentity } from './terminal';

interface TerminalRestartHandlerOptions {
    coordinator: AgentCoordinator;
    database: CaxriDatabase;
    send(event: ServerEvent): void;
    terminalDirectoryIdentity(cwd: string): Promise<TerminalWorkingDirectoryIdentity>;
    terminals: TerminalManager;
}

/**
 * Records an explicit Agent restart as work beginning only after the PTY restart succeeds.
 */
export function createTerminalRestartHandler(
    options: TerminalRestartHandlerOptions,
): DomainHandlers['terminal.restart'] {
    return async ({ mode, terminalId }) => {
        const current = options.database.getTerminal(terminalId);
        if (!current) throw new CaxriError('NOT_FOUND', 'Terminal not found');
        const expectedWorkingDirectory = await options.terminalDirectoryIdentity(current.cwd);
        const resumeAgentSessionId = mode === 'fresh' ? undefined : current.agentSessionId;
        if (resumeAgentSessionId) options.coordinator.prepareTerminalResume(terminalId);
        else options.coordinator.prepareTerminalStart(terminalId);
        const terminal = await options.terminals.restart(terminalId, {
            expectedWorkingDirectory,
            resumeAgentSessionId,
        });
        if (terminal.provider) options.coordinator.probeTerminal(terminal.id);
        const sessionIds = recordAgentRestart(options.database, terminal);
        options.send({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds, terminalIds: [terminal.id] },
        });
        return terminal;
    };
}

function recordAgentRestart(database: CaxriDatabase, terminal: TerminalRecord): string[] {
    if (!terminal.provider) return [];
    database.touchSessionActivity(terminal.sessionId, 'agent_started');
    return [terminal.sessionId];
}
