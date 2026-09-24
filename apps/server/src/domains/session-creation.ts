import type { TerminalKind } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { AgentCoordinator } from './agents';
import type { CaxriDatabase } from './db';
import type { DomainHandlers } from './domain-services';
import type { TerminalManager, TerminalSuspensionService } from './terminal';
import { terminalDirectoryIdentity } from './terminal';

export function createSessionCreator(dependencies: {
    coordinator: Pick<AgentCoordinator, 'prepareTerminalStart' | 'probeTerminal'>;
    database: CaxriDatabase;
    observeSelectedSession: (sessionId: string) => void;
    sendFullStateChange: () => void;
    terminalSuspension: Pick<TerminalSuspensionService, 'observeSelection'>;
    terminalWorkingDirectory: (options: {
        authorizedRoots: readonly string[];
        defaultRoot: string;
    }) => Promise<string>;
    terminals: Pick<TerminalManager, 'start'>;
}) {
    const {
        coordinator,
        database,
        observeSelectedSession,
        sendFullStateChange,
        terminalSuspension,
        terminalWorkingDirectory,
        terminals,
    } = dependencies;
    return async (
        projectId: string,
        defaultAgent: TerminalKind | null,
        selection: 'select' | 'preserve',
        signal?: AbortSignal,
    ) => {
        if (signal?.aborted) throw new CaxriError('CANCELLED', 'Session creation was canceled');
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
        const created = database.createSession(projectId, defaultAgent, cwd, { selection });
        let launchError: { code: 'TERMINAL_START_FAILED'; message: string } | undefined;
        if (created.terminal) {
            let expectedWorkingDirectory:
                Awaited<ReturnType<typeof terminalDirectoryIdentity>> | undefined;
            if (selection === 'select') {
                expectedWorkingDirectory = await terminalDirectoryIdentity(cwd!);
                coordinator.prepareTerminalStart(created.terminal.id);
            }
            try {
                expectedWorkingDirectory ??= await terminalDirectoryIdentity(cwd!);
                if (selection === 'preserve') coordinator.prepareTerminalStart(created.terminal.id);
                await terminals.start(created.terminal, { expectedWorkingDirectory });
            } catch {
                /**
                 * Keep the durable failed Terminal visible. Mobile reports partial success so a retry cannot silently
                 * create another Session; Desktop keeps its existing successful create response.
                 */
                if (selection === 'preserve') {
                    if (database.getTerminal(created.terminal.id)?.lastProcessState !== 'failed')
                        database.updateTerminalState(created.terminal.id, 'failed', 'spawn_failed');
                    launchError = {
                        code: 'TERMINAL_START_FAILED',
                        message:
                            'Terminal failed to start. The Session was created; open it to review the error.',
                    };
                }
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
