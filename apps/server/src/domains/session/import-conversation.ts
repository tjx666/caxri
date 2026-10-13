import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';

import type { AgentProvider, ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';
import { isTopLevelProject } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';

/**
 * The deepest visible top-level Project whose root contains `path`.
 */
function containingProject(
    projects: readonly ProjectRecord[],
    path: string,
): ProjectRecord | undefined {
    return projects
        .filter(
            (project) =>
                isTopLevelProject(project) &&
                (path === project.rootPath || path.startsWith(`${project.rootPath}${sep}`)),
        )
        .toSorted((left, right) => right.rootPath.length - left.rootPath.length)[0];
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
 * Creates the Session that holds an external conversation: a parked Agent Terminal bound to the conversation, so
 * opening the Session resumes it. Reuses the Project containing the conversation's folder, or adds one for it.
 * Selection stays where the user is. Returns `undefined` when the folder no longer resolves to a top-level Project
 * root.
 */
export async function importExternalConversation(
    database: CaxriDatabase,
    conversation: ImportableConversation,
    resolveProjectRoot: (path: string) => Promise<string>,
): Promise<{ session: SessionRecord; terminal: TerminalRecord } | undefined> {
    let project = await conversationProject(database.listVisibleProjects(), conversation.cwd);
    if (!project) {
        let rootPath: string;
        try {
            rootPath = await resolveProjectRoot(conversation.cwd);
        } catch {
            return undefined;
        }
        project = database.createProject(rootPath);
        if (!isTopLevelProject(project)) return undefined;
    }
    const { session } = database.createSession(project.id, null, undefined, {
        selection: 'preserve',
    });
    const title = conversation.title?.trim().slice(0, 200);
    if (title) database.renameSession(session.id, title);
    const terminal = database.createTerminal(session.id, conversation.provider, conversation.cwd);
    database.rebindAgentSession(terminal.id, conversation.provider, conversation.providerSessionId);
    database.updateTerminalState(terminal.id, 'detached');
    database.updateAgentProcessState(terminal.id, 'detached');
    return {
        session: database.getSession(session.id)!,
        terminal: database.getTerminal(terminal.id)!,
    };
}
