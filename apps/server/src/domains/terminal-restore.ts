import type { ServerEvent } from '@caxri/protocol';
import { visiblePaneTerminalIds } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { AgentCoordinator } from './agents';
import type { CaxriDatabase } from './db';
import type {
    TerminalManager,
    TerminalRestoreSupervisor,
    TerminalWorkingDirectoryIdentity,
} from './terminal';

interface InterruptedTerminalRestorerOptions {
    coordinator: AgentCoordinator;
    database: CaxriDatabase;
    logger: StructuredLogger;
    send: (event: ServerEvent) => void;
    terminalDirectoryIdentity: (path: string) => Promise<TerminalWorkingDirectoryIdentity>;
    terminalRestores: TerminalRestoreSupervisor;
    terminals: TerminalManager;
    visibleGridWaitMs: number;
}

export function createInterruptedTerminalRestorer(options: InterruptedTerminalRestorerOptions) {
    const {
        coordinator,
        database,
        logger,
        send,
        terminalDirectoryIdentity,
        terminalRestores,
        terminals,
        visibleGridWaitMs,
    } = options;
    /**
     * Auto-restores a Session's Terminals that an orderly shutdown left `interrupted` (GitHub issue #18). A Terminal
     * with a bound Agent conversation (`terminal.provider` set) resumes it via its Server provider descriptor, so
     * `coordinator.prepareTerminalStart` — which clears the Agent session binding through `resetAgentMetadataForStart`
     * — must be skipped for that Terminal; that clearing is exactly what a normal (non-resuming) start wants. A
     * Terminal without a bound conversation (a shell, or an Agent Terminal that never reached a capability-detected
     * session id) gets a fresh start instead. A spawn failure is left as `failed`; the user can restart it manually.
     * Restore work shares a global concurrency budget. Selecting another Session invalidates queued work, and the
     * generation is checked again after executable discovery immediately before spawn.
     */
    return async function restoreInterruptedTerminals(sessionId: string): Promise<void> {
        const sessionTerminals = database.listTerminals(sessionId);
        // Every pane shows its own active tab, so more than one Terminal can be on screen at once; each of them waits
        // for the attached grid size before replaying, which an off-screen Terminal has no reason to do.
        const visibleTerminalIds = new Set(
            visiblePaneTerminalIds(database.getSessionState(sessionId).paneLayout),
        );
        const interrupted = sessionTerminals.filter(
            (terminal) =>
                terminal.lastProcessState === 'interrupted' ||
                terminal.lastProcessState === 'suspended',
        );
        const restored = await terminalRestores.restore(
            sessionId,
            interrupted.map((terminal) => async (isCurrent, abortSignal) => {
                const shouldRestoreAgent = [
                    'interrupted',
                    'running',
                    'starting',
                    'suspended',
                ].includes(terminal.lastAgentProcessState ?? 'stopped');
                const resumeAgentSessionId =
                    shouldRestoreAgent && terminal.provider ? terminal.agentSessionId : undefined;
                if (resumeAgentSessionId) coordinator.prepareTerminalResume(terminal.id);
                else if (shouldRestoreAgent) coordinator.prepareTerminalStart(terminal.id);
                try {
                    const expectedWorkingDirectory = await terminalDirectoryIdentity(terminal.cwd);
                    const restarted = await terminals.restart(terminal.id, {
                        expectedWorkingDirectory,
                        launchAgent: shouldRestoreAgent,
                        resumeAgentSessionId,
                        shouldStart: isCurrent,
                        abortSignal,
                        waitForAttachedSizeMs: visibleTerminalIds.has(terminal.id)
                            ? visibleGridWaitMs
                            : undefined,
                    });
                    if (restarted.lastProcessState !== 'running') return false;
                } catch {
                    const current = database.getTerminal(terminal.id);
                    if (
                        current?.lastProcessState === 'interrupted' ||
                        current?.lastProcessState === 'suspended'
                    ) {
                        database.updateTerminalState(
                            terminal.id,
                            'failed',
                            'working_directory_unavailable',
                        );
                        logger.write('warn', logEventCatalog.terminal.restoreCwdRejected, {
                            fields: { terminalId: terminal.id },
                        });
                    }
                    if (database.getTerminal(terminal.id)?.lastProcessState === 'failed')
                        send({
                            event: 'state.changed',
                            payload: {
                                kind: 'records',
                                sessionIds: [],
                                terminalIds: [terminal.id],
                            },
                        });
                    return false;
                }
                if (terminal.provider) coordinator.probeTerminal(terminal.id);
                return true;
            }),
        );
        const restoredTerminalIds: string[] = [];
        for (const [index, terminal] of interrupted.entries())
            if (restored[index]) restoredTerminalIds.push(terminal.id);
        if (restoredTerminalIds.length > 0)
            send({
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [], terminalIds: restoredTerminalIds },
            });
    };
}
