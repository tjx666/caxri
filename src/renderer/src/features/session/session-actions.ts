import type { TerminalKind } from '@shared/types';

import { caxri } from '../../lib/caxri';
import { clearPendingSession, useDialogStore } from '../../state/dialogs';
import { getBootstrap, getSelectedSession, selectSelectedProject } from '../../state/selectors';
import { useSessionViewStore } from '../../state/session-view';
import { tryCommand } from '../../state/toasts';
import { refreshWorkbench } from '../../state/workbench';

export async function selectSession(sessionId: string): Promise<void> {
    await tryCommand(
        'Session selection failed',
        () => caxri.request('session.select', { sessionId }),
        { refresh: true },
    );
}

async function createSession(projectId: string, defaultAgent: TerminalKind): Promise<void> {
    await tryCommand(
        'Session creation failed',
        async () => {
            await caxri.request('session.create', { projectId, defaultAgent });
            clearPendingSession();
        },
        { refresh: true },
    );
}

async function createProjectSession(rootPath: string, defaultAgent: TerminalKind): Promise<void> {
    await tryCommand('Project creation failed', async () => {
        const project = await caxri.request('project.create', { rootPath });
        /** Keeps the Agent-choice dialog open, now anchored to the created Project. */
        useDialogStore.getState().askAgentForProject(project.id);
        await createSession(project.id, defaultAgent);
    });
}

/** Skips the Agent-choice dialog whenever the user configured a default Agent. */
export function beginSessionCreation(projectId: string): void {
    const defaultAgent = getBootstrap()?.settings['session.defaultAgent'];
    if (defaultAgent) void createSession(projectId, defaultAgent);
    else useDialogStore.getState().askAgentForProject(projectId);
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
    const session = getBootstrap()?.sessions.find((item) => item.projectId === projectId);
    if (session) void selectSession(session.id);
    else beginSessionCreation(projectId);
}

/**
 * The directory-picker grant is a single-use Main-process authorization, so abandoning the Agent
 * choice must revoke it instead of leaving the root reachable.
 */
export function cancelPendingSession(): void {
    const pendingRoot = useDialogStore.getState().pendingRoot;
    if (pendingRoot) void caxri.request('project.cancelCreate', { rootPath: pendingRoot });
    clearPendingSession();
}

export function confirmPendingSession(kind: TerminalKind): void {
    const { pendingRoot, pendingProjectId } = useDialogStore.getState();
    if (pendingRoot) void createProjectSession(pendingRoot, kind);
    else if (pendingProjectId) void createSession(pendingProjectId, kind);
}

export function deleteSelectedProject(): void {
    const bootstrap = getBootstrap();
    const project = selectSelectedProject(bootstrap);
    if (!bootstrap || !project) return;
    void tryCommand('Project removal failed', async () => {
        const result = await caxri.request('project.delete', { projectId: project.id });
        if ('canceled' in result) return;
        useSessionViewStore
            .getState()
            .dropSessions(
                bootstrap.sessions
                    .filter((session) => session.projectId === project.id)
                    .map((session) => session.id),
            );
        await refreshWorkbench();
    });
}

export function deleteSelectedSession(): void {
    const session = getSelectedSession();
    if (!session) return;
    void tryCommand('Session deletion failed', async () => {
        const result = await caxri.request('session.delete', { sessionId: session.id });
        if ('canceled' in result) return;
        useSessionViewStore.getState().dropSessions([session.id]);
        await refreshWorkbench();
    });
}

export function selectAdjacentSession(delta: 1 | -1): void {
    const bootstrap = getBootstrap();
    if (!bootstrap || bootstrap.sessions.length === 0) return;
    const selectedIndex = bootstrap.sessions.findIndex(
        (session) => session.id === getSelectedSession()?.id,
    );
    if (selectedIndex < 0) return;
    const next =
        bootstrap.sessions[
            (selectedIndex + delta + bootstrap.sessions.length) % bootstrap.sessions.length
        ];
    if (next) void selectSession(next.id);
}
