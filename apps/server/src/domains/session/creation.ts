import type { TerminalKind, TerminalRecord, TerminalSurface } from '@caxri/protocol';
import { canUseAgentChat, CaxriError } from '@caxri/protocol';

import type { AgentCoordinator } from '../agents';
import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';
import type { TerminalManager, TerminalSuspensionService } from '../terminal';
import { terminalDirectoryIdentity } from '../terminal';

/**
 * A "Fork from here" Chat keeps the source Chat's stored permission level and plan mode in place of the Project default
 * it was created with, so a fork of a narrowed Chat stays as narrow as its source. A source that stored no choice (no
 * level and plan mode off, the same columns as none) leaves the fork on the current Project default.
 */
export function inheritChatPermission(
    database: CaxriDatabase,
    sourceTerminalId: string,
    terminalId: string,
): void {
    const stored = database.getChatPermission(sourceTerminalId);
    if (stored && (stored.permissionMode !== undefined || stored.planMode))
        database.setChatPermission(terminalId, stored);
}

/**
 * Whether a new Session also becomes a window's active one. `preserve` leaves every window alone (remote creation,
 * background work); otherwise the named window shows the Session like a plain select.
 */
export type CreationSelection = 'preserve' | { windowKey?: string };

const selectionOptions = (selection: CreationSelection) =>
    selection === 'preserve'
        ? { selection }
        : {
              selection: 'select' as const,
              ...(selection.windowKey !== undefined && { windowKey: selection.windowKey }),
          };

export function createSessionCreator(dependencies: {
    coordinator: Pick<AgentCoordinator, 'prepareTerminalStart' | 'probeTerminal'>;
    database: CaxriDatabase;
    noteWindowViewing: (windowKey: string, sessionId: string) => void;
    sendFullStateChange: () => void;
    /**
     * Starts the provider behind a new Chat Terminal. A Chat has no PTY for `terminals.start` to launch.
     */
    startChat: (terminalId: string) => void;
    terminalSuspension: Pick<TerminalSuspensionService, 'observeVisibility'>;
    terminalWorkingDirectory: (options: {
        authorizedRoots: readonly string[];
        defaultRoot: string;
    }) => Promise<string>;
    terminals: Pick<TerminalManager, 'launches' | 'start'>;
}) {
    const {
        coordinator,
        database,
        noteWindowViewing,
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
        selection: CreationSelection,
        fork: { agentSessionId: string | undefined; sourceTerminalId: string } | undefined,
    ): {
        session: ReturnType<CaxriDatabase['createSession']>['session'];
        terminal: TerminalRecord;
    } => {
        const { session } = database.createSession(
            projectId,
            null,
            undefined,
            selectionOptions(selection),
        );
        const terminal = database.createTerminal(session.id, kind, cwd, 'chat');
        if (fork) inheritChatPermission(database, fork.sourceTerminalId, terminal.id);
        // Bound before the start, which then resumes the forked record instead of opening a new conversation.
        if (kind !== 'shell' && fork?.agentSessionId)
            database.rebindAgentSession(terminal.id, kind, fork.agentSessionId);
        startChat(terminal.id);
        return { session, terminal };
    };
    return async (
        projectId: string,
        defaultAgent: TerminalKind | null,
        selection: CreationSelection,
        signal?: AbortSignal,
        surface: TerminalSurface = 'pty',
        /**
         * A "Fork from here" Chat: the source Chat's cwd (already authorized for it), the forked Agent Session, and the
         * source Chat Terminal whose stored permission level and plan mode the fork inherits.
         */
        fork?: { cwd: string; agentSessionId: string | undefined; sourceTerminalId: string },
    ) => {
        if (signal?.aborted) throw new CaxriError('CANCELLED', 'Session creation was canceled');
        const chatAgent = surface === 'chat' ? defaultAgent : null;
        // Checked before anything is written, so a refused Chat never leaves an empty Session behind.
        if (surface === 'chat' && (!chatAgent || !canUseAgentChat(chatAgent)))
            throw new CaxriError('VALIDATION', 'This Agent does not support Chat');
        const project = database.getProject(projectId);
        if (!project) throw new CaxriError('NOT_FOUND', 'Project not found');
        const cwd = fork
            ? fork.cwd
            : defaultAgent
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
            ? createChatSession(projectId, chatAgent, cwd!, selection, fork)
            : database.createSession(projectId, defaultAgent, cwd, selectionOptions(selection));
        let launchError: { code: 'TERMINAL_START_FAILED'; message: string } | undefined;
        if (!chatAgent && created.terminal) {
            // The Session exists from here: a detach or Terminate and Close starting during the lookup below must wait.
            const prepared = terminals.launches.begin(created.session.id);
            try {
                let expectedWorkingDirectory:
                    Awaited<ReturnType<typeof terminalDirectoryIdentity>> | undefined;
                if (selection !== 'preserve') {
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
        if (selection !== 'preserve') {
            database.selectSession(created.session.id, selection.windowKey);
            if (selection.windowKey) noteWindowViewing(selection.windowKey, created.session.id);
            terminalSuspension.observeVisibility();
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

/**
 * `session.create` for Desktop, and the Mobile pair: the generic method is refused because a device creates Sessions
 * only through its authenticated principal.
 */
export function createSessionCreationHandlers(
    database: CaxriDatabase,
    createSessionForProject: ReturnType<typeof createSessionCreator>,
): Pick<
    DomainHandlers,
    'mobile.session.create' | 'mobile.session.createForPrincipal' | 'session.create'
> {
    return {
        'session.create': ({ projectId, defaultAgent, surface, windowKey }) =>
            createSessionForProject(
                projectId,
                defaultAgent,
                windowKey !== undefined ? { windowKey } : {},
                undefined,
                surface,
            ),
        'mobile.session.create': () => {
            throw new CaxriError('FORBIDDEN', 'Mobile Session creation requires a paired device');
        },
        'mobile.session.createForPrincipal': createMobileSessionHandler(
            database,
            createSessionForProject,
        ),
    };
}

export function createMobileSessionHandler(
    database: CaxriDatabase,
    createSessionForProject: ReturnType<typeof createSessionCreator>,
): DomainHandlers['mobile.session.createForPrincipal'] {
    return async ({ projectId, defaultAgent, surface, principal }, signal) => {
        if (
            principal.kind !== 'paired-device' ||
            principal.role !== 'control' ||
            !principal.projectIds.includes(projectId)
        )
            throw new CaxriError('FORBIDDEN', 'Project is not authorized for this device');
        if (database.listVisibleProjects().every((project) => project.id !== projectId))
            throw new CaxriError('NOT_FOUND', 'Project not found');
        const created = await createSessionForProject(
            projectId,
            defaultAgent,
            'preserve',
            signal,
            surface,
        );
        return {
            sessionId: created.session.id,
            ...(created.terminal && { terminalId: created.terminal.id }),
            ...(created.launchError && { launchError: created.launchError }),
        };
    };
}
