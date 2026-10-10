import type { ServerEvent, TerminalRecord, TerminalSurface } from '@caxri/protocol';
import { canUseAgentChat, CaxriError, isChatTerminal } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { AgentCoordinator, AgentEnvironment } from './agents';
import type { CaxriDatabase } from './db';
import type { DomainHandlers } from './domain-services';
import type { TerminalManager, TerminalWorkingDirectoryIdentity } from './terminal';
import { resumableAgentSessionId } from './terminal-restore';

export interface TerminalSurfaceSwitchOptions {
    agentEnvironment?: AgentEnvironment;
    coordinator: AgentCoordinator;
    database: CaxriDatabase;
    logger: StructuredLogger;
    send(event: ServerEvent): void;
    terminalDirectoryIdentity(cwd: string): Promise<TerminalWorkingDirectoryIdentity>;
    terminals: TerminalManager;
    chat: {
        close(terminalId: string): Promise<void>;
        hasActiveTurn(terminalId: string): boolean;
        /**
         * Starts the Chat provider on the Terminal's bound Agent Session, clearing any previous projection.
         */
        restart(terminalId: string): Promise<TerminalRecord>;
    };
}

/**
 * `startedNew` is a switch of an Agent with no conversation to carry over yet: the other surface opens a new one.
 */
type SwitchOutcome = 'switched' | 'startedNew' | 'turnRunning' | 'failed';

/**
 * A PTY Agent's turn is only observable through the Session's validated lifecycle state, which follows the Primary
 * Agent. A secondary PTY Agent has no per-Terminal turn state, so it switches without a prompt, as its restart does.
 */
function isPtyTurnRunning(database: CaxriDatabase, terminal: TerminalRecord): boolean {
    if (terminal.lastAgentProcessState !== 'running') return false;
    const session = database.getSession(terminal.sessionId);
    return (
        session?.primaryAgentTerminalId === terminal.id &&
        (session.lastActivityState === 'running' || session.lastActivityState === 'waiting')
    );
}

/**
 * Reopens a bound Agent Terminal on the other surface: stop the current process, flip `surface`, and resume the same
 * Agent Session there (Codex `thread/resume` and `codex resume` share one thread; Claude Code's SDK `resume` and
 * `claude --resume` share one session). The Terminal row, its tab, Primary Agent election, and title stay. An Agent
 * that has not written a conversation yet has nothing to lose, so it switches too and starts a new conversation there,
 * as a fresh restart would. See ADR 0012.
 */
export function createTerminalSurfaceSwitchHandler(
    options: TerminalSurfaceSwitchOptions,
): DomainHandlers['terminal.switchSurface'] {
    return async ({ interruptTurn, surface, terminalId }) => {
        const startedAt = Date.now();
        const current = options.database.getTerminal(terminalId);
        if (!current) throw new CaxriError('NOT_FOUND', 'Terminal not found');
        const { provider } = current;
        if (!provider || !canUseAgentChat(current.kind))
            throw new CaxriError('UNAVAILABLE', 'Only a Chat-capable Agent can switch views');
        const from: TerminalSurface = isChatTerminal(current) ? 'chat' : 'pty';
        if (from === surface) return { status: 'switched', terminal: current };
        const log = (outcome: SwitchOutcome) =>
            options.logger.write(
                outcome === 'failed' ? 'warn' : 'info',
                logEventCatalog.terminal.surfaceSwitched,
                {
                    fields: {
                        terminalId,
                        provider,
                        from,
                        to: surface,
                        outcome,
                        interruptTurn,
                        durationMs: Date.now() - startedAt,
                    },
                },
            );

        /**
         * Every await from here precedes the relaunch, so a detach that starts during them waits for it: a PTY that
         * lands is handed over by `parkLaunch`, and a Chat by the detach's own Chat close that runs afterward.
         */
        const prepared = options.terminals.launches.begin(current.sessionId);
        try {
            const agentSessionId = await resumableAgentSessionId(options, current, 'surfaceSwitch');
            const isTurnRunning =
                from === 'chat'
                    ? options.chat.hasActiveTurn(terminalId)
                    : isPtyTurnRunning(options.database, current);
            if (isTurnRunning && !interruptTurn) {
                log('turnRunning');
                return { status: 'turnRunning' };
            }

            try {
                if (from === 'chat') await options.chat.close(terminalId);
                else await options.terminals.suspend(terminalId, 'stopped', 'surfaceSwitched');
                if (!options.database.getTerminal(terminalId))
                    throw new CaxriError('CONFLICT', 'Terminal was closed while switching');
                options.database.updateTerminalSurface(terminalId, surface);
                // Starting fresh drops a binding whose conversation was never written, so neither surface tries to resume it.
                if (agentSessionId) options.coordinator.prepareTerminalResume(terminalId);
                else options.coordinator.prepareTerminalStart(terminalId);
                let terminal: TerminalRecord;
                if (surface === 'chat') terminal = await options.chat.restart(terminalId);
                else {
                    const expectedWorkingDirectory = await options.terminalDirectoryIdentity(
                        current.cwd,
                    );
                    terminal = await options.terminals.restart(terminalId, {
                        expectedWorkingDirectory,
                        // The Chat's orderly stop left the Agent `stopped`, which on its own reads as "start only a Shell".
                        launchAgent: true,
                        resumeAgentSessionId: agentSessionId,
                    });
                    options.coordinator.probeTerminal(terminal.id);
                }
                options.send({
                    event: 'state.changed',
                    payload: {
                        kind: 'records',
                        sessionIds: [terminal.sessionId],
                        terminalIds: [terminal.id],
                    },
                });
                log(agentSessionId ? 'switched' : 'startedNew');
                return { status: 'switched', terminal };
            } catch (error) {
                log('failed');
                throw error;
            }
        } finally {
            prepared();
        }
    };
}
