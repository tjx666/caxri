import type { AgentLaunchSettings, ServerEvent, TerminalRecord } from '@caxri/protocol';
import { CaxriError, isDelegationActive, visiblePaneTerminalIds } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import { delegationResumeLaunch } from '../agent-delegation';
import type { AgentCoordinator, AgentEnvironment } from '../agents';
import { isAgentConversationUnwritten } from '../agents';
import type { CaxriDatabase } from '../db';
import { isPtyTerminal } from '../pty-guard';
import type { TerminalManager } from './manager';
import type { TerminalWorkingDirectoryIdentity } from './manager-types';
import type { TerminalRestoreOperation } from './restore-supervisor';
import { TerminalRestoreSupervisor } from './restore-supervisor';

interface InterruptedTerminalRestorerOptions {
    agentEnvironment?: AgentEnvironment;
    coordinator: AgentCoordinator;
    database: CaxriDatabase;
    logger: StructuredLogger;
    send: (event: ServerEvent) => void;
    terminalDirectoryIdentity: (path: string) => Promise<TerminalWorkingDirectoryIdentity>;
    terminalRestores: TerminalRestoreSupervisor;
    terminals: TerminalManager;
    /**
     * Where delegation task files live, so a restored delegated Agent keeps the directory grant its task launched with.
     */
    userDataPath: string;
    /**
     * How long a visible Terminal waits for its pane's attached grid before its PTY starts anyway.
     */
    visibleGridWaitMs?: number;
}

const VISIBLE_TERMINAL_RESTORE_GRID_WAIT_MS = 5_000;

/**
 * How a Terminal's delegated Agent comes back. While one of its tasks is still active, only the outer Shell restores:
 * that task continues through an explicit `--resume`, which must not race a second copy of the same conversation. Once
 * every task settled, the Agent resumes like any other, with the frozen launch configuration its newest task ran with,
 * so a restart does not quietly swap in the user's default model or effort. `undefined` means no delegation touched
 * it.
 */
function delegatedAgentRestore(
    database: CaxriDatabase,
    terminal: TerminalRecord,
    userDataPath: string,
): { launchSettings?: AgentLaunchSettings; shouldRestoreAgent: boolean } | undefined {
    const tasks = database.agentDelegations.forTerminal(terminal.id);
    if (tasks.length === 0) return undefined;
    if (tasks.some((task) => isDelegationActive(task.receipt)))
        return { shouldRestoreAgent: false };
    const newest = tasks.reduce((latest, task) =>
        task.receipt.createdAt > latest.receipt.createdAt ? task : latest,
    );
    return {
        launchSettings: delegationResumeLaunch(newest, userDataPath),
        shouldRestoreAgent: true,
    };
}

/**
 * The bound conversation to pass to `--resume`, or `undefined` when the provider provably never wrote it (see
 * `isAgentConversationUnwritten`). Dropping the id turns the relaunch into a fresh start, which is all an empty
 * conversation could have resumed to; the skip is logged because it otherwise looks identical to an ordinary start.
 */
export async function resumableAgentSessionId(
    options: {
        agentEnvironment?: AgentEnvironment;
        database: CaxriDatabase;
        logger: StructuredLogger;
    },
    terminal: TerminalRecord,
    source: 'restart' | 'restore' | 'surfaceSwitch',
): Promise<string | undefined> {
    if (!terminal.provider || !terminal.agentSessionId) return undefined;
    if (
        !(await isAgentConversationUnwritten(
            options.database,
            terminal.id,
            options.agentEnvironment,
        ))
    )
        return terminal.agentSessionId;
    options.logger.write('info', logEventCatalog.terminal.resumeSkipped, {
        fields: {
            provider: terminal.provider,
            reason: 'conversation_unwritten',
            sessionId: terminal.sessionId,
            source,
            terminalId: terminal.id,
        },
    });
    return undefined;
}

export interface TerminalRestoreOptions {
    /**
     * `detached` Terminals were parked by the user for another client and must survive an ordinary Session selection;
     * only the explicit `session.resume` request opts them back in.
     */
    includeDetached?: boolean;
}

/**
 * The Agent Commander Session is never selected, so it restores through its own supervisor: sharing the Workbench's
 * would let the next Session selection abort the Commander's resume.
 */
export function createCommanderTerminalRestorer(
    options: Omit<InterruptedTerminalRestorerOptions, 'terminalRestores'>,
) {
    const supervisor = new TerminalRestoreSupervisor(1);
    return {
        restore: createInterruptedTerminalRestorer({ ...options, terminalRestores: supervisor }),
        supervisor,
    };
}

export function createInterruptedTerminalRestorer(options: InterruptedTerminalRestorerOptions) {
    const {
        agentEnvironment,
        coordinator,
        database,
        logger,
        send,
        terminalDirectoryIdentity,
        terminalRestores,
        terminals,
        userDataPath,
        visibleGridWaitMs = VISIBLE_TERMINAL_RESTORE_GRID_WAIT_MS,
    } = options;
    /**
     * Auto-restores a Session's Terminals that an orderly shutdown left `interrupted` (GitHub issue #18) or that the
     * background suspension sweep parked as `suspended`. A Terminal with a bound Agent conversation
     * (`terminal.provider` set) resumes it via its Server provider descriptor, so `coordinator.prepareTerminalStart`,
     * which clears the Agent session binding through `resetAgentMetadataForStart`, must be skipped for that Terminal;
     * that clearing is exactly what a normal (non-resuming) start wants. A Terminal without a bound conversation (a
     * shell, or an Agent Terminal that never reached a capability-detected session id) gets a fresh start instead. A
     * spawn failure is left as `failed`; the user can restart it manually. Restore work shares a global concurrency
     * budget. Selecting another Session invalidates queued work, and the generation is checked again after executable
     * discovery immediately before spawn.
     */
    return async function restoreInterruptedTerminals(
        sessionId: string,
        options: TerminalRestoreOptions = {},
    ): Promise<void> {
        let interrupted: ReturnType<typeof database.listTerminals> = [];
        /**
         * Evaluated when the restore actually starts: a resume queued behind the selection restore must list Terminals
         * after that restore has changed their state, not before.
         */
        const planOperations = (): TerminalRestoreOperation[] => {
            const sessionTerminals = database.listTerminals(sessionId);
            // Every pane shows its own active tab, so more than one Terminal can be on screen at once; each of them waits
            // for the attached grid size before replaying, which an off-screen Terminal has no reason to do.
            const visibleTerminalIds = new Set(
                visiblePaneTerminalIds(database.getSessionState(sessionId).paneLayout),
            );
            // A Chat resumes lazily on its next read; restore relaunches PTYs only.
            interrupted = sessionTerminals.filter(
                (terminal) =>
                    isPtyTerminal(terminal) &&
                    (terminal.lastProcessState === 'interrupted' ||
                        terminal.lastProcessState === 'suspended' ||
                        (options.includeDetached && terminal.lastProcessState === 'detached')),
            );
            return interrupted.map(
                (terminal) =>
                    async (isCurrent, abortSignal): Promise<boolean> => {
                        const delegated = delegatedAgentRestore(database, terminal, userDataPath);
                        const shouldRestoreAgent =
                            (delegated?.shouldRestoreAgent ?? true) &&
                            [
                                'detached',
                                'interrupted',
                                'running',
                                'starting',
                                'suspended',
                            ].includes(terminal.lastAgentProcessState ?? 'stopped');
                        const resumeAgentSessionId = shouldRestoreAgent
                            ? await resumableAgentSessionId(
                                  { agentEnvironment, database, logger },
                                  terminal,
                                  'restore',
                              )
                            : undefined;
                        if (
                            shouldRestoreAgent &&
                            !resumeAgentSessionId &&
                            terminal.provider === 'grok'
                        ) {
                            database.updateTerminalState(
                                terminal.id,
                                'failed',
                                'agent_session_unavailable',
                            );
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
                        if (resumeAgentSessionId) coordinator.prepareTerminalResume(terminal.id);
                        else if (shouldRestoreAgent) coordinator.prepareTerminalStart(terminal.id);
                        try {
                            const expectedWorkingDirectory = await terminalDirectoryIdentity(
                                terminal.cwd,
                            );
                            const restarted = await terminals.restart(terminal.id, {
                                expectedWorkingDirectory,
                                launchAgent: shouldRestoreAgent,
                                resumeAgentSessionId,
                                ...(shouldRestoreAgent &&
                                    delegated?.launchSettings && {
                                        launchSettings: delegated.launchSettings,
                                    }),
                                shouldStart: isCurrent,
                                abortSignal,
                                waitForAttachedSizeMs: visibleTerminalIds.has(terminal.id)
                                    ? visibleGridWaitMs
                                    : undefined,
                            });
                            if (restarted.lastProcessState !== 'running') return false;
                        } catch (error) {
                            // Over the Terminal limit the record stays parked and restores once a slot frees, rather than
                            // being marked failed for a reason that has nothing to do with its directory.
                            if (error instanceof CaxriError && error.code === 'CAPACITY')
                                return false;
                            const current = database.getTerminal(terminal.id);
                            if (
                                current?.lastProcessState === 'interrupted' ||
                                current?.lastProcessState === 'suspended' ||
                                current?.lastProcessState === 'detached'
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
                    },
            );
        };
        const restored = await terminalRestores.restore(sessionId, planOperations, {
            afterActive: options.includeDetached === true,
        });
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
