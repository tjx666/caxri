import type {
    AgentDelegationReceipt,
    CommanderBoard,
    CommanderBoardGroupId,
    CommanderBoardRow,
    ProjectRecord,
    SessionPullRequests,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import {
    commanderBoardGroupIds,
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
 * Mirrors the Workbench Activity grouping without its Renderer-only selection anchor: unread first, then failure, live
 * work, and requests for input. A turn recorded as running whose Terminal is no longer alive is idle, not working.
 */
export function commanderBoardGroup(
    session: SessionRecord,
    terminal: TerminalRecord | undefined,
    now: number,
): CommanderBoardGroupId {
    if (session.hasUnread) return 'attention';
    if (session.lastActivityState === 'failed') return 'failed';
    const isAlive = terminal !== undefined && LIVE_PROCESS_STATES.has(terminal.lastProcessState);
    if (session.lastActivityState === 'running') return isAlive ? 'working' : 'idle';
    if (session.lastActivityState === 'waiting') return isAlive ? 'waiting' : 'idle';
    if (
        session.lastActivityState === 'completed' &&
        now - session.lastSessionActivityAt < COMMANDER_FINISHED_RETENTION_MS
    )
        return 'finished';
    return 'idle';
}

function latestTaskBySession(
    tasks: readonly AgentDelegationReceipt[],
): Map<string, CommanderBoardRow['task']> {
    const latest = new Map<string, AgentDelegationReceipt>();
    for (const task of tasks) {
        const current = latest.get(task.sessionId);
        if (!current || task.createdAt > current.createdAt) latest.set(task.sessionId, task);
    }
    return new Map(
        [...latest].map(([sessionId, { delegationId, status, failure, updatedAt }]) => [
            sessionId,
            { delegationId, status, ...(failure && { failure }), updatedAt },
        ]),
    );
}

/**
 * Projects the visible Workbench into the Commander board: every top-level Project and its unarchived Sessions, most
 * recent activity first within each group. Pull requests come from the cached snapshot and never wait on GitHub.
 * `tasks` are the Commander's own delegation receipts; each Commander Session shows its latest one.
 */
export function commanderBoard(input: {
    commanderSessionIds: ReadonlySet<string>;
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
    const tasks = latestTaskBySession(input.tasks);
    const order = new Map(commanderBoardGroupIds.map((id, index) => [id, index]));
    const rows = input.sessions.flatMap((session): CommanderBoardRow[] => {
        const project = projectsById.get(session.projectId);
        if (!project || session.archivedAt !== undefined) return [];
        const terminal = boardAgent(session, terminalsBySession.get(session.id) ?? []);
        const pullRequest = pullRequests.get(session.id);
        const pullRequestUnavailable = input.pullRequests.unavailable?.[session.id];
        const task = tasks.get(session.id);
        return [
            {
                group: commanderBoardGroup(session, terminal, input.now),
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
                          processState: terminal.lastProcessState,
                          operation: terminal.agentOperation,
                      }
                    : null,
                ...(pullRequest && { pullRequest }),
                ...(pullRequestUnavailable && { pullRequestUnavailable }),
                commanderSession: input.commanderSessionIds.has(session.id),
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
    };
}
