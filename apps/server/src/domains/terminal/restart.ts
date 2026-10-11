import type { ServerEvent, TerminalRecord } from '@caxri/protocol';
import { CaxriError, isChatTerminal } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentCoordinator, AgentEnvironment } from '../agents';
import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';
import type { TerminalManager } from './manager';
import type { TerminalWorkingDirectoryIdentity } from './manager-types';
import { resumableAgentSessionId } from './restore';

interface TerminalRestartHandlerOptions {
    agentEnvironment?: AgentEnvironment;
    coordinator: AgentCoordinator;
    database: CaxriDatabase;
    logger: StructuredLogger;
    send(event: ServerEvent): void;
    terminalDirectoryIdentity(cwd: string): Promise<TerminalWorkingDirectoryIdentity>;
    terminals: TerminalManager;
    /**
     * Restarts a Chat Terminal's provider process; a Chat never reaches the PTY restart path.
     */
    restartChat(terminalId: string, shouldKeepAgentAutonomy: boolean): Promise<TerminalRecord>;
}

/**
 * Records an explicit Agent restart only after the PTY restart succeeds. This operation deliberately replaces the
 * surrounding Shell as well as the Agent: injecting a launch into a live prompt could execute inside an unpublished
 * edit or disturb foreground job control. Restarting updates recency, but a validated lifecycle signal still owns
 * whether the Agent is executing a turn.
 *
 * A `resume` restart (the Terminal's Restart, the menus' Reload Agent) continues the same Agent Session, so it also
 * keeps the approval mode the replaced Agent Run launched with: a run started in YOLO comes back in YOLO even if the
 * Settings switch was turned off since, and the reverse. Every other launch argument follows the current Settings, so a
 * reload still picks up a changed model or flag. A `fresh` restart starts a new conversation on the current Settings.
 */
export function createTerminalRestartHandler(
    options: TerminalRestartHandlerOptions,
): DomainHandlers['terminal.restart'] {
    return async ({ mode, terminalId }) => {
        const current = options.database.getTerminal(terminalId);
        if (!current) throw new CaxriError('NOT_FOUND', 'Terminal not found');
        /**
         * Every await below precedes the relaunch, so a detach that starts during them waits for it: a PTY that lands
         * is handed over by `parkLaunch`, and a Chat by the detach's own Chat close that runs afterward.
         */
        const prepared = options.terminals.launches.begin(current.sessionId);
        let terminal: TerminalRecord;
        try {
            if (isChatTerminal(current)) {
                // A fresh restart drops the Agent Session binding so the next start opens a new conversation.
                if (mode === 'fresh') options.coordinator.prepareTerminalStart(terminalId);
                terminal = await options.restartChat(terminalId, mode !== 'fresh');
            } else {
                if (mode !== 'fresh' && !current.agentSessionId && current.provider === 'grok')
                    throw new CaxriError(
                        'UNAVAILABLE',
                        'Original Grok Build Session identity is unavailable; start a new Session explicitly',
                    );
                const expectedWorkingDirectory = await options.terminalDirectoryIdentity(
                    current.cwd,
                );
                const resumeAgentSessionId =
                    mode === 'fresh'
                        ? undefined
                        : await resumableAgentSessionId(options, current, 'restart');
                if (resumeAgentSessionId) options.coordinator.prepareTerminalResume(terminalId);
                else options.coordinator.prepareTerminalStart(terminalId);
                terminal = await options.terminals.restart(terminalId, {
                    expectedWorkingDirectory,
                    resumeAgentSessionId,
                    shouldKeepAgentAutonomy: mode !== 'fresh',
                });
                if (terminal.provider) options.coordinator.probeTerminal(terminal.id);
            }
        } finally {
            prepared();
        }
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
