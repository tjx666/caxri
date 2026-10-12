import type { AgentCoordinator } from '../agents';
import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';
import type { TerminalRestoreOptions, TerminalSuspensionService } from '../terminal';
import { SessionSelectionQueue } from './selection';

interface SessionSelectionHandlerOptions {
    agentChat: { resumeSession(sessionId: string): void };
    coordinator: Pick<AgentCoordinator, 'probeSessionPrimaryAgent'>;
    database: Pick<CaxriDatabase, 'getSession' | 'selectSession'>;
    mobileTerminalMutations: {
        runSessions<T>(sessionIds: readonly string[], task: () => Promise<T> | T): Promise<T>;
    };
    terminalSuspension: Pick<TerminalSuspensionService, 'observeSelection'>;
    workbenchRoots: { validateSession(sessionId: string): Promise<boolean> };
    observeSelectedSession: (sessionId: string) => void;
    restoreInterruptedTerminalsInBackground: (
        sessionId: string,
        options?: TerminalRestoreOptions,
    ) => void;
    sendFullStateChange: (reason: 'session.resume' | 'session.select') => void;
}

/**
 * Durable Session selection and resume. Both run through one {@link SessionSelectionQueue} so the newest invocation
 * stays authoritative.
 */
export function createSessionSelectionHandlers(
    options: SessionSelectionHandlerOptions,
): Pick<DomainHandlers, 'session.resume' | 'session.select'> {
    const {
        agentChat,
        coordinator,
        database,
        mobileTerminalMutations,
        observeSelectedSession,
        restoreInterruptedTerminalsInBackground,
        sendFullStateChange,
        terminalSuspension,
        workbenchRoots,
    } = options;
    const sessionSelections = new SessionSelectionQueue();
    return {
        'session.select': ({ sessionId }) =>
            sessionSelections.run(async () => {
                await workbenchRoots.validateSession(sessionId);
                database.selectSession(sessionId);
                terminalSuspension.observeSelection();
                observeSelectedSession(sessionId);
                restoreInterruptedTerminalsInBackground(sessionId);
                coordinator.probeSessionPrimaryAgent(sessionId);
                sendFullStateChange('session.select');
                return database.getSession(sessionId)!;
            }),
        // Under `session.detach`'s Session lock: a resume sent mid-detach relaunches everything it handed over.
        'session.resume': ({ sessionId }) =>
            sessionSelections.run(() =>
                mobileTerminalMutations.runSessions([sessionId], async () => {
                    await workbenchRoots.validateSession(sessionId);
                    database.selectSession(sessionId);
                    terminalSuspension.observeSelection();
                    observeSelectedSession(sessionId);
                    // Detached Chats and PTY Agents both relaunch here, on the Agent Sessions they handed over.
                    agentChat.resumeSession(sessionId);
                    restoreInterruptedTerminalsInBackground(sessionId, { includeDetached: true });
                    coordinator.probeSessionPrimaryAgent(sessionId);
                    sendFullStateChange('session.resume');
                    return database.getSession(sessionId)!;
                }),
            ),
    };
}
