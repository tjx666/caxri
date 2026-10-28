import { lstat, realpath } from 'node:fs/promises';
import { sep } from 'node:path';

import type { AgentProvider, ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { isTopLevelProject } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import type { GitWorktreeTopology } from '../git';

/**
 * The deepest visible top-level Project whose root contains `path`.
 */
function containingProject(
    projects: readonly ProjectRecord[],
    path: string,
): ProjectRecord | undefined {
    return projects
        .filter((project) => isTopLevelProject(project) && isInside(path, project.rootPath))
        .toSorted((left, right) => right.rootPath.length - left.rootPath.length)
        .at(0);
}

/**
 * The Project that contains an external conversation's folder. Provider history records the cwd as the Agent saw it,
 * which may run through a symlinked alias (macOS `/tmp` for `/private/tmp`), while Project roots are canonical; the
 * canonical folder is matched first so such a conversation lands in its existing Project instead of a nested new one. A
 * folder that no longer resolves falls back to the recorded path.
 */
export async function conversationProject(
    projects: readonly ProjectRecord[],
    cwd: string,
): Promise<ProjectRecord | undefined> {
    let canonical = cwd;
    try {
        canonical = await realpath(cwd);
    } catch {
        // A vanished folder keeps the recorded path; the import then refuses it as missing.
    }
    return containingProject(projects, canonical) ?? containingProject(projects, cwd);
}

/**
 * One provider conversation to adopt, as read fresh from its transcript.
 */
interface ImportableConversation {
    provider: AgentProvider;
    providerSessionId: string;
    cwd: string;
    title?: string;
}

/**
 * Reads the linked-worktree topology of the repository containing a folder; see `GitService.worktreeTopology`.
 */
export type WorktreeTopologyReader = (path: string) => Promise<GitWorktreeTopology>;

interface ConversationPlacement {
    project: ProjectRecord;
    /**
     * The linked worktree of `project` the conversation ran in, which becomes the Session's Workbench Root.
     */
    worktreeRoot?: string;
}

/**
 * The visible top-level Project whose repository has the folder as a linked worktree, and that worktree's root. A
 * conversation started in a worktree checkout kept outside the Project folder then lands in the Project it belongs to,
 * working in that worktree, as a Session the user moved there would, instead of adding the checkout as a new Project.
 * Anything that is not a Git checkout, or whose repository no visible Project owns, has no placement here.
 */
async function worktreePlacement(
    projects: readonly ProjectRecord[],
    cwd: string,
    readTopology: WorktreeTopologyReader,
): Promise<ConversationPlacement | undefined> {
    let topology: GitWorktreeTopology;
    let canonical: string;
    try {
        canonical = await realpath(cwd);
        topology = await readTopology(canonical);
    } catch {
        return undefined;
    }
    const worktree = topology.worktrees
        .filter((entry) => isInside(canonical, entry.rootPath))
        .toSorted((left, right) => right.rootPath.length - left.rootPath.length)
        .at(0);
    if (!worktree || worktree.isMain) return undefined;
    const roots = new Set(topology.worktrees.map((entry) => entry.rootPath));
    const owner = projects.find(
        (project) => isTopLevelProject(project) && roots.has(project.rootPath),
    );
    return owner && { project: owner, worktreeRoot: worktree.rootPath };
}

export function isInside(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}${sep}`);
}

/**
 * Creates the Session that holds an external conversation: a parked Agent Terminal bound to the conversation, so
 * opening the Session resumes it. Reuses the Project containing the conversation's folder, else the Project whose
 * linked worktree it ran in (with that worktree as the Workbench Root), or adds a Project for it. The transcript's
 * title starts as the Session's automatic title, so naming the conversation later still replaces it. Selection stays
 * where the user is. Returns `undefined` when the folder no longer resolves to a top-level Project root.
 */
export async function importExternalConversation(
    database: CaxriDatabase,
    conversation: ImportableConversation,
    resolveProjectRoot: (path: string) => Promise<string>,
    readTopology?: WorktreeTopologyReader,
): Promise<{ session: SessionRecord; terminal: TerminalRecord } | undefined> {
    const projects = database.listVisibleProjects();
    const containing = await conversationProject(projects, conversation.cwd);
    let placement: ConversationPlacement | undefined = containing && { project: containing };
    if (!placement && readTopology)
        placement = await worktreePlacement(projects, conversation.cwd, readTopology);
    if (!placement) {
        let rootPath: string;
        try {
            rootPath = await resolveProjectRoot(conversation.cwd);
        } catch {
            return undefined;
        }
        const project = database.createProject(rootPath);
        if (!isTopLevelProject(project)) return undefined;
        placement = { project };
    }
    const title = conversation.title?.trim().slice(0, 200);
    const { session } = database.createSession(placement.project.id, null, undefined, {
        selection: 'preserve',
        ...(title && { title }),
    });
    if (placement.worktreeRoot) {
        const worktree = database.createProject(placement.worktreeRoot, placement.project.id);
        database.selectWorkbenchProject(
            session.id,
            worktree.id,
            await rootIdentity(worktree.rootPath),
        );
    }
    const terminal = database.createTerminal(session.id, conversation.provider, conversation.cwd);
    database.rebindAgentSession(terminal.id, conversation.provider, conversation.providerSessionId);
    database.updateTerminalState(terminal.id, 'detached');
    database.updateAgentProcessState(terminal.id, 'detached');
    return {
        session: database.getSession(session.id)!,
        terminal: database.getTerminal(terminal.id)!,
    };
}

async function rootIdentity(path: string): Promise<{ device: string; inode: string }> {
    const stats = await lstat(path, { bigint: true });
    return { device: stats.dev.toString(), inode: stats.ino.toString() };
}
