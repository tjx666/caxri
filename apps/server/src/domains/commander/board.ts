import type {
    AgentDelegationReceipt,
    CommanderBoard,
    CommanderBoardGroupId,
    CommanderBoardRow,
    CommanderHandover,
    CommanderTask,
    ProcessState,
    ProjectRecord,
    SessionPullRequests,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import {
    commanderBoardGroupIds,
    isDelegationActive,
    isTopLevelProject,
    MAX_COMMANDER_BOARD_ROWS,
} from '@caxri/protocol';

/**
 * How long a completed Session stays under "Recently finished". Longer than the Workbench Activity view's window
 * because the Commander reviews finished work in batches, often hours after the Agent stopped.
 */
export const COMMANDER_FINISHED_RETENTION_MS = 24 * 60 * 60 * 1_000;

const LIVE_PROCESS_STATES = new Set<TerminalRecord['lastProcessState']>(['starting', 'running']);

function boardAgent(
    session: SessionRecord,
    terminals: readonly TerminalRecord[],
): TerminalRecord | undefined {
    return (
        terminals.find((terminal) => terminal.id === session.primaryAgentTerminalId) ??
        terminals.find((terminal) => terminal.kind !== 'shell') ??
        terminals.at(0)
    );
}

/**
 * The state of the process a row describes. An Agent CLI runs inside a Shell PTY and can exit while the Shell lives on,
 * so once the Shell is up an Agent Terminal reports the Agent's own process, as `commander.status` does for the
 * Commander itself; a plain Shell reports the Shell.
 */
function rowProcessState(terminal: TerminalRecord): ProcessState {
    const shell = terminal.lastProcessState;
    if (terminal.kind === 'shell' || !LIVE_PROCESS_STATES.has(shell)) return shell;
    if (shell === 'starting') return 'starting';
    return terminal.lastAgentProcessState ?? 'stopped';
}

/**
 * Mirrors the Workbench Activity grouping without its Renderer-only selection anchor: unread first, then failure, live
 * work, and requests for input. A turn recorded as running whose Agent is no longer alive is idle, not working.
 */
export function commanderBoardGroup(
    session: SessionRecord,
    terminal: TerminalRecord | undefined,
    now: number,
): CommanderBoardGroupId {
    if (session.hasUnread) return 'attention';
    if (session.lastActivityState === 'failed') return 'failed';
    const isAlive = terminal !== undefined && LIVE_PROCESS_STATES.has(rowProcessState(terminal));
    if (session.lastActivityState === 'running') return isAlive ? 'working' : 'idle';
    if (session.lastActivityState === 'waiting') return isAlive ? 'waiting' : 'idle';
    if (
        session.lastActivityState === 'completed' &&
        now - session.lastSessionActivityAt < COMMANDER_FINISHED_RETENTION_MS
    )
        return 'finished';
    return 'idle';
}

/**
 * Picks the task each Commander Session shows: an unsettled one (running or blocked) wins over a settled one, and the
 * newest wins otherwise, so a finished side task never hides work that still needs someone. A follow-up is admitted
 * only once its parent settled, so a continued chain shows its newest link without special handling, while a follow-up
 * rejected because its parent still runs or waits never hides that parent.
 */
function currentTaskBySession(
    tasks: readonly AgentDelegationReceipt[],
): Map<string, CommanderBoardRow['task']> {
    const current = new Map<string, AgentDelegationReceipt>();
    for (const task of tasks) {
        const shown = current.get(task.sessionId);
        const outranks =
            !shown ||
            (isDelegationActive(task) === isDelegationActive(shown)
                ? task.createdAt > shown.createdAt
                : isDelegationActive(task));
        if (outranks) current.set(task.sessionId, task);
    }
    return new Map(
        [...current].map(([sessionId, { delegationId, status, failure, updatedAt }]) => [
            sessionId,
            { delegationId, status, ...(failure && { failure }), updatedAt },
        ]),
    );
}

/**
 * Where a Commander task moves its row regardless of Session activity. An Agent waiting at startup has no lifecycle
 * hooks yet, so its Session looks idle, but only the user can answer the prompt it is stuck on. A task that failed to
 * start or to return its answer often left no Session activity at all, and would otherwise sit under `idle`.
 */
function taskGroup(task: CommanderBoardRow['task']): CommanderBoardGroupId | undefined {
    if (task?.status === 'blocked' && task.failure === 'startup_waiting') return 'attention';
    if (task?.status === 'failed' || task?.status === 'answer_unavailable') return 'failed';
    return undefined;
}

/**
 * Projects the visible Workbench into the Commander board: every top-level Project and its unarchived Sessions, most
 * recent activity first within each group. Pull requests come from the cached snapshot and never wait on GitHub.
 * `tasks` are the Commander's own delegation receipts; each Commander Session shows its current one.
 */
export function commanderBoard(input: {
    /**
     * The Commander's open ledger tasks, already bounded and ordered by the ledger.
     */
    commanderTasks: readonly CommanderTask[];
    commanderSessionIds: ReadonlySet<string>;
    /**
     * The user's hand-overs; one the Commander already continued is no longer shown.
     */
    handovers?: readonly CommanderHandover[];
    now: number;
    projects: readonly ProjectRecord[];
    pullRequests: SessionPullRequests;
    sessions: readonly SessionRecord[];
    tasks: readonly AgentDelegationReceipt[];
    terminals: readonly TerminalRecord[];
}): CommanderBoard {
    const projects = input.projects.filter((project) => isTopLevelProject(project));
    const projectsById = new Map(projects.map((project) => [project.id, project]));
    const terminalsBySession = Map.groupBy(input.terminals, (terminal) => terminal.sessionId);
    const pullRequests = new Map(Object.entries(input.pullRequests.pullRequests));
    const tasks = currentTaskBySession(input.tasks);
    const handovers = new Map(
        (input.handovers ?? []).flatMap(
            (handover): Array<[string, CommanderBoardRow['handover']]> =>
                handover.firstDelegationId
                    ? []
                    : [
                          [
                              handover.sessionId,
                              {
                                  handoverId: handover.id,
                                  state: handover.target ? 'continuable' : 'ownership_only',
                                  ...(handover.ownershipReason && {
                                      ownershipReason: handover.ownershipReason,
                                  }),
                              },
                          ],
                      ],
        ),
    );
    const order = new Map(commanderBoardGroupIds.map((id, index) => [id, index]));
    const rows = input.sessions.flatMap((session): CommanderBoardRow[] => {
        const project = projectsById.get(session.projectId);
        if (!project || session.archivedAt !== undefined) return [];
        const terminal = boardAgent(session, terminalsBySession.get(session.id) ?? []);
        const pullRequest = pullRequests.get(session.id);
        const pullRequestUnavailable = input.pullRequests.unavailable?.[session.id];
        const task = tasks.get(session.id);
        const handover = handovers.get(session.id);
        const sessionGroup = commanderBoardGroup(session, terminal, input.now);
        return [
            {
                group:
                    sessionGroup === 'attention' ? sessionGroup : (taskGroup(task) ?? sessionGroup),
                projectId: project.id,
                projectTitle: project.displayTitle,
                projectRoot: project.rootPath,
                sessionId: session.id,
                sessionTitle: session.displayTitle,
                activityState: session.lastActivityState,
                hasUnread: session.hasUnread,
                lastActivityAt: session.lastSessionActivityAt,
                agent: terminal
                    ? {
                          terminalId: terminal.id,
                          kind: terminal.kind,
                          title: terminal.title,
                          processState: rowProcessState(terminal),
                          operation: terminal.agentOperation,
                      }
                    : null,
                ...(pullRequest && { pullRequest }),
                ...(pullRequestUnavailable && { pullRequestUnavailable }),
                commanderSession: input.commanderSessionIds.has(session.id),
                ...(handover && { handover }),
                ...(task && { task }),
            },
        ];
    });
    rows.sort(
        (left, right) =>
            order.get(left.group)! - order.get(right.group)! ||
            right.lastActivityAt - left.lastActivityAt,
    );
    return {
        generatedAt: input.now,
        pullRequestsRefreshedAt: input.pullRequests.refreshedAt,
        projects: projects.slice(0, MAX_COMMANDER_BOARD_ROWS).map((project) => ({
            id: project.id,
            title: project.displayTitle,
            rootPath: project.rootPath,
        })),
        rows: rows.slice(0, MAX_COMMANDER_BOARD_ROWS),
        tasks: [...input.commanderTasks],
    };
}
