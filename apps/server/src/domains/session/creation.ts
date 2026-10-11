import type { TerminalKind, TerminalRecord, TerminalSurface } from '@caxri/protocol';
import { canUseAgentChat, CaxriError } from '@caxri/protocol';

import type { AgentCoordinator } from '../agents';
import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';
import type { TerminalManager, TerminalSuspensionService } from '../terminal';
import { terminalDirectoryIdentity } from '../terminal';

export function createSessionCreator(dependencies: {
    coordinator: Pick<AgentCoordinator, 'prepareTerminalStart' | 'probeTerminal'>;
    database: CaxriDatabase;
    observeSelectedSession: (sessionId: string) => void;
    sendFullStateChange: () => void;
    /**
     * Starts the provider behind a new Chat Terminal. A Chat has no PTY for `terminals.start` to launch.
     */
    startChat: (terminalId: string) => void;
    terminalSuspension: Pick<TerminalSuspensionService, 'observeSelection'>;
    terminalWorkingDirectory: (options: {
        authorizedRoots: readonly string[];
        defaultRoot: string;
    }) => Promise<string>;
    terminals: Pick<TerminalManager, 'launches' | 'start'>;
}) {
    const {
        coordinator,
        database,
        observeSelectedSession,
        sendFullStateChange,
        startChat,
        terminalSuspension,
        terminalWorkingDirectory,
        terminals,
    } = dependencies;
    /**
     * A Chat Session is an empty Session plus a Chat Terminal, the same records `terminal.create` writes when a Chat is
     * added to an existing Session, so both paths place and assign the Terminal identically.
     */
    const createChatSession = (
        projectId: string,
        kind: TerminalKind,
        cwd: string,
        selection: 'select' | 'preserve',
    ): {
        session: ReturnType<CaxriDatabase['createSession']>['session'];
        terminal: TerminalRecord;
    } => {
        const { session } = database.createSession(projectId, null, undefined, { selection });
        const terminal = database.createTerminal(session.id, kind, cwd, 'chat');
        startChat(terminal.id);
        return { session, terminal };
    };
    return async (
        projectId: string,
        defaultAgent: TerminalKind | null,
        selection: 'select' | 'preserve',
        signal?: AbortSignal,
        surface: TerminalSurface = 'pty',
    ) => {
        if (signal?.aborted) throw new CaxriError('CANCELLED', 'Session creation was canceled');
        const chatAgent = surface === 'chat' ? defaultAgent : null;
        // Checked before anything is written, so a refused Chat never leaves an empty Session behind.
        if (surface === 'chat' && (!chatAgent || !canUseAgentChat(chatAgent)))
            throw new CaxriError('VALIDATION', 'This Agent does not support Chat');
        const project = database.getProject(projectId);
        if (!project) throw new CaxriError('NOT_FOUND', 'Project not found');
        const cwd = defaultAgent
            ? await terminalWorkingDirectory({
                  authorizedRoots: [project.rootPath],
                  defaultRoot: project.rootPath,
              })
            : undefined;
        /**
         * The final cancellation check is adjacent to the synchronous durable creation transaction.
         */
        if (signal?.aborted) throw new CaxriError('CANCELLED', 'Session creation was canceled');
        const created = chatAgent
            ? createChatSession(projectId, chatAgent, cwd!, selection)
            : database.createSession(projectId, defaultAgent, cwd, { selection });
        let launchError: { code: 'TERMINAL_START_FAILED'; message: string } | undefined;
        if (!chatAgent && created.terminal) {
            // The Session exists from here: a detach or Terminate and Close starting during the lookup below must wait.
            const prepared = terminals.launches.begin(created.session.id);
            try {
                let expectedWorkingDirectory:
                    Awaited<ReturnType<typeof terminalDirectoryIdentity>> | undefined;
                if (selection === 'select') {
                    expectedWorkingDirectory = await terminalDirectoryIdentity(cwd!);
                    coordinator.prepareTerminalStart(created.terminal.id);
                }
                try {
                    expectedWorkingDirectory ??= await terminalDirectoryIdentity(cwd!);
                    if (selection === 'preserve')
                        coordinator.prepareTerminalStart(created.terminal.id);
                    await terminals.start(created.terminal, { expectedWorkingDirectory });
                } catch {
                    /**
                     * Keep the durable failed Terminal visible. Mobile reports partial success so a retry cannot
                     * silently create another Session; Desktop keeps its existing successful create response.
                     */
                    if (selection === 'preserve') {
                        if (
                            database.getTerminal(created.terminal.id)?.lastProcessState !== 'failed'
                        )
                            database.updateTerminalState(
                                created.terminal.id,
                                'failed',
                                'spawn_failed',
                            );
                        launchError = {
                            code: 'TERMINAL_START_FAILED',
                            message:
                                'Terminal failed to start. The Session was created; open it to review the error.',
                        };
                    }
                }
            } finally {
                prepared();
            }
        }
        if (selection === 'select') {
            database.selectSession(created.session.id);
            terminalSuspension.observeSelection();
            observeSelectedSession(created.session.id);
        }
        if (created.terminal?.provider) coordinator.probeTerminal(created.terminal.id);
        sendFullStateChange();
        return {
            session: database.getSession(created.session.id)!,
            terminal: created.terminal ? database.getTerminal(created.terminal.id)! : null,
            ...(launchError && { launchError }),
        };
    };
}

export function createMobileSessionHandler(
    database: CaxriDatabase,
    createSessionForProject: ReturnType<typeof createSessionCreator>,
): DomainHandlers['mobile.session.createForPrincipal'] {
    return async ({ projectId, defaultAgent, principal }, signal) => {
        if (
            principal.kind !== 'paired-device' ||
            principal.role !== 'control' ||
            !principal.projectIds.includes(projectId)
        )
            throw new CaxriError('FORBIDDEN', 'Project is not authorized for this device');
        if (database.listVisibleProjects().every((project) => project.id !== projectId))
            throw new CaxriError('NOT_FOUND', 'Project not found');
        const created = await createSessionForProject(projectId, defaultAgent, 'preserve', signal);
        return {
            sessionId: created.session.id,
            ...(created.terminal && { terminalId: created.terminal.id }),
            ...(created.launchError && { launchError: created.launchError }),
        };
    };
}
