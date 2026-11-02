import { isTopLevelProject } from '@caxri/protocol';
import { and, eq, isNull } from 'drizzle-orm';

import type { CaxriDatabaseConnection } from './database-connection';
import { listVisibleProjects } from './project-visibility';
import { sessions } from './schema';

export interface ProjectRunningOrderChange {
    /**
     * Projects whose running Session count rose from zero.
     */
    started: string[];
    /**
     * Projects whose last running Session stopped.
     */
    stopped: string[];
    /**
     * Projects with a running Session after the change.
     */
    running: string[];
}

/**
 * The Project order after some Projects started or stopped running. A Project that starts running lands right after the
 * last Project that was already running, so the running group grows downward in the order work started and an idle
 * Project never jumps above one that is busy. A Project that stops falls back right after the running group, the top of
 * the idle Projects. Every other Project, including one the user dragged, keeps its relative place.
 */
export function projectOrderAfterRunningChange(
    order: readonly string[],
    previouslyRunning: ReadonlySet<string>,
    running: ReadonlySet<string>,
): string[] {
    const started = order.filter((id) => running.has(id) && !previouslyRunning.has(id));
    const stopped = order.filter((id) => previouslyRunning.has(id) && !running.has(id));
    const moved = new Set([...started, ...stopped]);
    const rest = order.filter((id) => !moved.has(id));
    const insertAt = rest.findLastIndex((id) => running.has(id)) + 1;
    return [...rest.slice(0, insertAt), ...started, ...stopped, ...rest.slice(insertAt)];
}

/**
 * The Projects owning at least one unarchived Session whose Agent is running. A narrow query rather than the full
 * Session list, because this runs after every state change.
 */
function runningSessionProjectIds(database: CaxriDatabaseConnection): string[] {
    return database.db
        .selectDistinct({ projectId: sessions.projectId })
        .from(sessions)
        .where(and(eq(sessions.agentActivityState, 'running'), isNull(sessions.archivedAt)))
        .all()
        .map((row) => row.projectId);
}

/**
 * Moves Projects whose running state changed since the last call and records the new running set. Runs inside the
 * caller's transaction. Returns the change only when the Project order actually moved.
 *
 * Only Projects the PrimarySidebar shows take part: a Session working in an auto-registered worktree Project counts
 * toward its owner, and hidden Projects and Caxri Bot's own Project are ignored.
 */
export function reconcileProjectRunningOrder(
    database: CaxriDatabaseConnection,
): ProjectRunningOrderChange | undefined {
    const projects = database.projects.list();
    const visibleIds = new Set(
        listVisibleProjects(database)
            .filter((project) => isTopLevelProject(project))
            .map((project) => project.id),
    );
    const ownerOf = new Map(
        projects.map((project) => [project.id, project.ownerProjectId ?? project.id]),
    );
    const running = new Set(
        runningSessionProjectIds(database)
            .flatMap((projectId) => ownerOf.get(projectId) ?? [])
            .filter((projectId) => visibleIds.has(projectId)),
    );
    const stored = database.appState.get('runningProjectIds') ?? [];
    const previouslyRunning = new Set(stored.filter((projectId) => visibleIds.has(projectId)));
    const isUnchanged =
        stored.length === running.size && stored.every((projectId) => running.has(projectId));
    if (isUnchanged) return;

    const order = projects.filter((project) => isTopLevelProject(project)).map(({ id }) => id);
    const owned = projects.filter((project) => !isTopLevelProject(project)).map(({ id }) => id);
    const next = projectOrderAfterRunningChange(order, previouslyRunning, running);
    database.appState.set(
        'runningProjectIds',
        next.filter((projectId) => running.has(projectId)),
    );
    if (next.every((projectId, index) => projectId === order[index])) return;
    database.projects.reorder([...next, ...owned]);
    return {
        started: order.filter((id) => running.has(id) && !previouslyRunning.has(id)),
        stopped: order.filter((id) => previouslyRunning.has(id) && !running.has(id)),
        running: [...running],
    };
}
