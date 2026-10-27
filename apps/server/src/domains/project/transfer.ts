import { lstat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import type {
    ProjectRecord,
    ProjectTransferDocument,
    ProjectTransferImportResult,
    ProjectTransferSession,
    ProjectTransferTerminal,
    ServerEvent,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import {
    CaxriError,
    isTopLevelProject,
    MAX_PROJECT_TRANSFER_FILE_BYTES,
    PROJECT_TRANSFER_FORMAT,
    PROJECT_TRANSFER_FORMAT_VERSION,
    projectTransferDocumentSchema,
} from '@caxri/protocol';
import { readBoundedRegularFileText } from '@caxri/system';

import { chatStateStore } from '../agent-chat';
import { atomicWrite } from '../atomic-file';
import type { AgentChatStateModel, CaxriDatabase } from '../db';
import { resolveOwnerProjectRoot } from './root-identity';

type TransferDatabase = Pick<
    CaxriDatabase,
    | 'createProject'
    | 'createSession'
    | 'createTerminal'
    | 'findProjectByRootPath'
    | 'getSession'
    | 'listSessions'
    | 'listTerminals'
    | 'listVisibleProjects'
    | 'rebindAgentSession'
    | 'renameSession'
    | 'selectWorkbenchProject'
    | 'setSessionPinned'
    | 'updateAgentProcessState'
    | 'updateTerminalState'
>;

/**
 * The rewind point store; see `chatStateStore`.
 */
type TransferChatState = Pick<AgentChatStateModel, 'resumeAt' | 'setResumeAt'>;

function isInside(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}${sep}`);
}

function exportedTerminal(
    chatState: TransferChatState,
    terminal: TerminalRecord,
): ProjectTransferTerminal | undefined {
    if (terminal.kind === 'shell' || !terminal.agentSessionId) return undefined;
    const resumeAt = chatState.resumeAt(terminal.id);
    return {
        provider: terminal.kind,
        surface: terminal.surface ?? 'pty',
        // The provider files the conversation under the folder the Agent worked in, which `agentCwd` records when an
        // in-Agent worktree switch moved it away from the launch folder.
        cwd: terminal.agentCwd ?? terminal.cwd,
        agentSessionId: terminal.agentSessionId,
        ...(resumeAt !== undefined && { resumeAt }),
    };
}

function exportedSession(
    database: TransferDatabase,
    chatState: TransferChatState,
    project: ProjectRecord,
    session: SessionRecord,
): ProjectTransferSession {
    return {
        title: session.title,
        titleMode: session.titleMode,
        pinned: session.pinnedAt !== undefined,
        ...(session.workbenchRootProjectId !== project.id && {
            workbenchRootPath: session.rootPath,
        }),
        terminals: database
            .listTerminals(session.id)
            .toSorted((left, right) => left.orderIndex - right.orderIndex)
            .map((terminal) => exportedTerminal(chatState, terminal))
            .filter((terminal) => terminal !== undefined),
    };
}

/**
 * The user's visible top-level Projects and their unarchived Sessions, in PrimarySidebar order. Worktree Projects
 * travel as the Workbench Root of the Sessions that work in them; hidden Projects, archived Sessions, Caxri Bot's own
 * Project, and appearance (icons and colors) are left out.
 */
export function exportProjectTransfer(
    database: TransferDatabase,
    chatState: TransferChatState,
    now = Date.now(),
): ProjectTransferDocument {
    return {
        format: PROJECT_TRANSFER_FORMAT,
        formatVersion: PROJECT_TRANSFER_FORMAT_VERSION,
        exportedAt: now,
        projects: database
            .listVisibleProjects()
            .filter(isTopLevelProject)
            .map((project) => ({
                rootPath: project.rootPath,
                sessions: database
                    .listSessions(project.id)
                    .filter((session) => session.archivedAt === undefined)
                    .toSorted(
                        (left, right) =>
                            left.sidebarOrder - right.sidebarOrder ||
                            left.createdAt - right.createdAt,
                    )
                    .map((session) => exportedSession(database, chatState, project, session)),
            })),
    };
}

export async function writeProjectTransfer(
    database: CaxriDatabase,
    destination: string,
): Promise<{ path: string; projectCount: number; sessionCount: number }> {
    const document = exportProjectTransfer(database, chatStateStore(database));
    await atomicWrite(destination, `${JSON.stringify(document, null, 2)}\n`);
    return {
        path: destination,
        projectCount: document.projects.length,
        sessionCount: document.projects.reduce(
            (count, project) => count + project.sessions.length,
            0,
        ),
    };
}

export function parseProjectTransfer(source: string): ProjectTransferDocument {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch {
        throw new CaxriError('VALIDATION', 'The file is not a Caxri Projects and Sessions export');
    }
    const parsed = projectTransferDocumentSchema.safeParse(value);
    if (!parsed.success)
        throw new CaxriError('VALIDATION', 'The file is not a Caxri Projects and Sessions export');
    return parsed.data;
}

/**
 * A worktree folder bound to the same filesystem object the import resolved, or `undefined` once it is gone. Workbench
 * Root validation later confirms it still belongs to the Project's repository and falls back to the Project root
 * otherwise.
 */
async function resolveWorkbenchRoot(
    path: string,
): Promise<{ path: string; identity: { device: string; inode: string } } | undefined> {
    try {
        const canonical = await realpath(path);
        const stats = await lstat(canonical, { bigint: true });
        if (!stats.isDirectory()) return undefined;
        return {
            path: canonical,
            identity: { device: stats.dev.toString(), inode: stats.ino.toString() },
        };
    } catch {
        return undefined;
    }
}

async function importSession(
    database: TransferDatabase,
    chatState: TransferChatState,
    project: ProjectRecord,
    exported: ProjectTransferSession,
    missingWorkbenchRoots: string[],
): Promise<SessionRecord> {
    // An automatic title starts as the Session's own, so the Agent's conversation name keeps replacing it.
    const { session } = database.createSession(project.id, null, undefined, {
        selection: 'preserve',
        ...(exported.titleMode === 'automatic' && { title: exported.title }),
    });
    let rootPath = project.rootPath;
    if (exported.workbenchRootPath) {
        const workbench = await resolveWorkbenchRoot(exported.workbenchRootPath);
        if (workbench && workbench.path !== project.rootPath) {
            const worktree = database.createProject(workbench.path, project.id);
            database.selectWorkbenchProject(session.id, worktree.id, workbench.identity);
            rootPath = workbench.path;
        } else if (!workbench) missingWorkbenchRoots.push(exported.workbenchRootPath);
    }
    for (const terminal of exported.terminals) {
        // A folder outside both authorized roots could not launch; the Agent then resumes from the Session's root.
        // `resolve` collapses `..` segments so a hand-edited path cannot pass the prefix check while pointing elsewhere.
        const exportedCwd = resolve(terminal.cwd);
        const cwd =
            isInside(exportedCwd, project.rootPath) || isInside(exportedCwd, rootPath)
                ? exportedCwd
                : rootPath;
        const created = database.createTerminal(
            session.id,
            terminal.provider,
            cwd,
            terminal.surface,
        );
        database.rebindAgentSession(created.id, terminal.provider, terminal.agentSessionId);
        database.updateTerminalState(created.id, 'detached');
        database.updateAgentProcessState(created.id, 'detached');
        if (terminal.resumeAt !== undefined) chatState.setResumeAt(created.id, terminal.resumeAt);
    }
    return exported.titleMode === 'manual'
        ? database.renameSession(session.id, exported.title)
        : database.getSession(session.id)!;
}

/**
 * Recreates the exported Projects and Sessions with new IDs. A Project whose folder is gone, or that is already
 * present, is skipped as a whole, so importing the same file twice never duplicates Sessions. Sessions are created
 * bottom-up because each new Session takes the top of its Project, and pins are applied in export order afterward.
 */
async function importProjectTransfer(
    database: TransferDatabase,
    chatState: TransferChatState,
    document: ProjectTransferDocument,
    emit: (event: ServerEvent) => void,
): Promise<ProjectTransferImportResult> {
    const result: ProjectTransferImportResult = {
        projectCount: 0,
        sessionCount: 0,
        skipped: [],
        missingWorkbenchRoots: [],
    };
    const pinned: SessionRecord[] = [];
    try {
        for (const exported of document.projects) {
            let rootPath: string;
            try {
                // eslint-disable-next-line no-await-in-loop -- Projects are created in file order, which sets their sidebar order
                rootPath = await resolveOwnerProjectRoot(exported.rootPath);
            } catch {
                result.skipped.push({ rootPath: exported.rootPath, reason: 'missing' });
                continue;
            }
            if (database.findProjectByRootPath(rootPath)) {
                result.skipped.push({ rootPath: exported.rootPath, reason: 'exists' });
                continue;
            }
            const project = database.createProject(rootPath);
            result.projectCount += 1;
            const imported: Array<{ session: SessionRecord; pinned: boolean }> = [];
            for (const session of exported.sessions.toReversed()) {
                // Each new Session takes the top of its Project, so creation order is the sidebar order.
                /* eslint-disable no-await-in-loop -- see above */
                // react-doctor-disable-next-line react-doctor/async-await-in-loop -- see above
                const created = await importSession(
                    database,
                    chatState,
                    project,
                    session,
                    result.missingWorkbenchRoots,
                );
                /* eslint-enable no-await-in-loop */
                imported.push({ session: created, pinned: session.pinned });
                result.sessionCount += 1;
            }
            for (const entry of imported.toReversed()) if (entry.pinned) pinned.push(entry.session);
        }
        for (const session of pinned) database.setSessionPinned(session.id, true);
    } finally {
        if (result.projectCount > 0)
            emit({ event: 'state.changed', payload: { kind: 'full', reason: 'project.import' } });
    }
    return result;
}

async function readProjectTransfer(path: string): Promise<ProjectTransferDocument> {
    return parseProjectTransfer(
        await readBoundedRegularFileText(path, MAX_PROJECT_TRANSFER_FILE_BYTES, {
            capacityMessage: `The export exceeds the ${MAX_PROJECT_TRANSFER_FILE_BYTES} byte import limit`,
        }),
    );
}

export async function importProjectTransferFile(
    database: CaxriDatabase,
    path: string,
    emit: (event: ServerEvent) => void,
): Promise<ProjectTransferImportResult> {
    const document = await readProjectTransfer(path);
    return importProjectTransfer(database, chatStateStore(database), document, emit);
}
