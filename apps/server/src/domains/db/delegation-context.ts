import type { AgentProvider, SessionRecord } from '@caxri/protocol';
import { CaxriError, isTopLevelProject } from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';

/**
 * Idempotent owner bootstrap commits Project, Session and binding together without changing visible selection. A
 * Project the user hid is un-hidden (`ProjectsModel.create` restores the existing row, order, and Sessions): the
 * delegated Session would otherwise run in a Project the Desktop user cannot see. The caller emits the `state.changed`
 * that makes the Project reappear at the sidebar.
 */
export function ensureDelegationContext(
    database: CaxriDatabaseConnection,
    rootPath: string,
    provider: AgentProvider,
    isRegisterProject: boolean,
    createSession: (projectId: string) => SessionRecord,
) {
    return database.transaction(() => {
        let project = database.projects.findByRootPath(rootPath);
        if (!project && !isRegisterProject)
            throw new CaxriError(
                'PATH_DENIED',
                'Explicit --register-project authorization is required for this root',
            );
        project ??= database.projects.create(rootPath);
        if (!isTopLevelProject(project))
            throw new CaxriError(
                'PATH_DENIED',
                'Authorize a top-level Project root for external delegation',
            );
        if (project.hiddenAt !== undefined) project = database.projects.create(rootPath);
        const bindings = database.appState.get('externalDelegationSessions') ?? {};
        const key = `${project.id}:${provider}`;
        const previous = bindings[key] ? database.sessions.get(bindings[key]) : undefined;
        if (previous?.projectId === project.id && previous.archivedAt === undefined)
            return { projectId: project.id, sessionId: previous.id, callerProvider: provider };
        const selectedProject = database.appState.get('lastSelectedProjectId') ?? null;
        const session = createSession(project.id);
        database.appState.set('lastSelectedProjectId', selectedProject);
        const liveBindings = Object.fromEntries(
            Object.entries(bindings).filter(([, sessionId]) => database.sessions.get(sessionId)),
        );
        database.appState.set('externalDelegationSessions', { ...liveBindings, [key]: session.id });
        return { projectId: project.id, sessionId: session.id, callerProvider: provider };
    });
}
