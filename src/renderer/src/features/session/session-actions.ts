import type { TerminalKind } from '@shared/types';

import { caxri } from '../../lib/caxri';
import { queryClient } from '../../queries/client';
import { removeSessionQueries } from '../../queries/invalidation';
import { clearPendingSession, useDialogStore } from '../../stores/dialogs';
import { getBootstrap, getSelectedSession, selectSelectedProject } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import { tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';

export async function didSelectSession(sessionId: string): Promise<boolean> {
    const selected = await tryCommand(
        'Session selection failed',
        () => caxri.request('session.select', { sessionId }),
        { refresh: true },
    );
    return selected !== undefined;
}

async function createSession(projectId: string, defaultAgent: TerminalKind | null): Promise<void> {
    await tryCommand(
        'Session creation failed',
        async () => {
            await caxri.request('session.create', { projectId, defaultAgent });
            clearPendingSession();
        },
        { refresh: true },
    );
}

async function createProjectSession(
    rootPath: string,
    defaultAgent: TerminalKind | null,
): Promise<void> {
    await tryCommand('Project creation failed', async () => {
        const project = await caxri.request('project.create', { rootPath });
        /**
         * Keeps the Agent-choice dialog open, now anchored to the created Project.
         */
        useDialogStore.getState().askAgentForProject(project.id);
        await createSession(project.id, defaultAgent);
    });
}

/**
 * Skips the Agent-choice dialog whenever the user configured a default Agent.
 */
export function beginSessionCreation(projectId: string): void {
    const defaultAgent = getBootstrap()?.settings['session.defaultAgent'];
    if (defaultAgent) {
        // Fire-and-forget: `createSession` funnels its own failures into a toast via `tryCommand`.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void createSession(projectId, defaultAgent);
    } else useDialogStore.getState().askAgentForProject(projectId);
}

export async function chooseProjectDirectory(): Promise<void> {
    await tryCommand('Directory selection failed', async () => {
        const rootPath = await caxri.request('dialog.selectDirectory');
        if (!rootPath) return;
        const defaultAgent = getBootstrap()?.settings['session.defaultAgent'];
        if (defaultAgent) await createProjectSession(rootPath, defaultAgent);
        else useDialogStore.getState().askAgentForRoot(rootPath);
    });
}

export function selectProject(projectId: string): void {
    const session = getBootstrap()?.sessions.find(
        (item) => item.projectId === projectId && item.archivedAt === undefined,
    );
    // Fire-and-forget: `didSelectSession` funnels its own failures into a toast via `tryCommand`.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    if (session) void didSelectSession(session.id);
}

export async function didReorderProject(projectId: string, targetIndex: number): Promise<boolean> {
    const reordered = await tryCommand('Project reordering failed', () =>
        caxri.request('project.reorder', { projectId, targetIndex }),
    );
    return reordered !== undefined;
}

export function archiveSession(sessionId: string): void {
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand(
        'Session archive failed',
        () => caxri.request('session.archive', { sessionId }),
        { refresh: true },
    );
}

export function unarchiveSession(sessionId: string): void {
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand(
        'Session restore failed',
        () => caxri.request('session.unarchive', { sessionId }),
        { refresh: true },
    );
}

export async function didRenameSession(sessionId: string, displayTitle: string): Promise<boolean> {
    const renamed = await tryCommand(
        'Session rename failed',
        () => caxri.request('session.rename', { sessionId, displayTitle }),
        { refresh: true },
    );
    return renamed !== undefined;
}

/**
 * The directory-picker grant is a single-use Main-process authorization, so abandoning the Agent choice must revoke it
 * instead of leaving the root reachable.
 */
export function cancelPendingSession(): void {
    const pendingRoot = useDialogStore.getState().pendingRoot;
    if (pendingRoot) {
        // Fire-and-forget: revoking an abandoned directory-picker grant has no UI-visible outcome
        // to await, and a failure here has nothing left to affect besides the grant itself.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void caxri.request('project.cancelCreate', { rootPath: pendingRoot });
    }
    clearPendingSession();
}

export function confirmPendingSession(kind: TerminalKind | null): void {
    const { pendingRoot, pendingProjectId } = useDialogStore.getState();
    // Fire-and-forget: both `createProjectSession` and `createSession` funnel their own failures
    // into a toast via `tryCommand`.
    if (pendingRoot) {
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void createProjectSession(pendingRoot, kind);
    } else if (pendingProjectId) {
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void createSession(pendingProjectId, kind);
    }
}

export function deleteSelectedProject(): void {
    const bootstrap = getBootstrap();
    const project = selectSelectedProject(bootstrap);
    if (!bootstrap || !project) return;
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Project deletion failed', async () => {
        const result = await caxri.request('project.delete', { projectId: project.id });
        if ('canceled' in result) return;
        const removedSessionIds: string[] = [];
        for (const session of bootstrap.sessions)
            if (session.projectId === project.id) removedSessionIds.push(session.id);
        useSessionViewStore.getState().dropSessions(removedSessionIds);
        removeSessionQueries(queryClient, removedSessionIds);
        await refreshWorkbench();
    });
}

export function openSelectedProjectInExternalEditor(): void {
    const bootstrap = getBootstrap();
    const project = selectSelectedProject(bootstrap);
    if (!bootstrap || !project) return;
    const session = getSelectedSession();
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Opening the Project in the external editor failed', () =>
        caxri.request('project.openInEditor', {
            path: project.rootPath,
            ...(session?.projectId === project.id && { sessionId: session.id }),
        }),
    );
}

export function deleteSession(sessionId: string): void {
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Session deletion failed', async () => {
        const result = await caxri.request('session.delete', { sessionId });
        if ('canceled' in result) return;
        useSessionViewStore.getState().dropSessions([sessionId]);
        removeSessionQueries(queryClient, [sessionId]);
        await refreshWorkbench();
    });
}

export function deleteSelectedSession(): void {
    const session = getSelectedSession();
    if (!session) return;
    deleteSession(session.id);
}

/**
 * Moves a live Terminal (its PTY untouched) into a brand-new Session under the same Project, then switches to it —
 * analogous to a browser "move tab to new window". The Runtime already selects the new Session as part of the same
 * operation, so the `refresh: true` bootstrap re-fetch is all that is needed to reflect the switch, matching
 * `session.create`'s flow. The only-tab constraint is repeated at this request boundary so an accessibility or
 * synthetic activation of a disabled menu item cannot reach the Runtime.
 */
export function moveTerminalToNewSession(terminalId: string, isOnlyWorkTab = false): void {
    if (isOnlyWorkTab) return;
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand(
        'Move to new session failed',
        () => caxri.request('terminal.moveToNewSession', { terminalId }),
        { refresh: true },
    );
}

export function selectAdjacentSession(delta: 1 | -1): void {
    const bootstrap = getBootstrap();
    if (!bootstrap) return;
    const activeSessions = bootstrap.sessions.filter((session) => session.archivedAt === undefined);
    if (activeSessions.length === 0) return;
    const selectedIndex = activeSessions.findIndex(
        (session) => session.id === getSelectedSession()?.id,
    );
    if (selectedIndex === -1) return;
    const next =
        activeSessions[(selectedIndex + delta + activeSessions.length) % activeSessions.length];
    // Fire-and-forget: `didSelectSession` funnels its own failures into a toast via `tryCommand`.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void didSelectSession(next.id);
}
