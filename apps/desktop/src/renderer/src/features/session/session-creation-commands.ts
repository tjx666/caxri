import type { TerminalKind } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { useChromeLayoutStore } from '../../stores/chrome-layout';
import type { CreateSessionAnchor } from '../../stores/dialogs';
import { clearPendingSession, useDialogStore } from '../../stores/dialogs';
import { isLocalOnlyAvailable, isSshHost } from '../../stores/environment';
import { getBootstrap } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import { pickSshHostFolder } from '../ssh-host/ssh-host-dialogs-store';
import { newAgentSurface } from '../terminal/new-terminal-agent';
import { selectProject } from './session-commands';

async function createSession(projectId: string, defaultAgent: TerminalKind | null): Promise<void> {
    await tryCommand(
        translate('session.errors.createFailed'),
        async () => {
            /**
             * `session.openAgentsInChat` covers every Session entry: the anchored menu, the centered dialog, and direct
             * creation with a configured default Agent. A Chat-incapable Agent quietly stays a PTY.
             */
            const surface = defaultAgent
                ? newAgentSurface(
                      defaultAgent,
                      getBootstrap()?.settings['session.openAgentsInChat'],
                  )
                : 'pty';
            await caxri.request('session.create', {
                projectId,
                defaultAgent,
                ...(surface === 'chat' && { surface }),
            });
            clearPendingSession();
        },
        { refresh: refreshWorkbench },
    );
}

async function createProjectSession(
    rootPath: string,
    defaultAgent: TerminalKind | null,
): Promise<void> {
    await tryCommand(translate('session.errors.createProjectFailed'), async () => {
        const project = await caxri.request('project.create', { rootPath });
        /**
         * Keeps the Agent-choice dialog open, now anchored to the created Project.
         */
        useDialogStore.getState().askAgentForProject(project.id);
        await createSession(project.id, defaultAgent);
    });
}

/**
 * Skips the Terminal choice whenever the user configured a default Agent. Otherwise it opens the Project row's anchored
 * menu rather than a centered dialog: the trigger already sits under the pointer, so the choice should too.
 *
 * `anchor` names the trigger the menu should hang from; it defaults to the Project heading so callers with no row of
 * their own (the command palette, the native menu, a shortcut) keep opening it there.
 *
 * The menu lives inside the Primary Side Bar, so `session.create` from the native menu, a shortcut, or the command
 * palette would otherwise mark a Project whose row is not mounted and do nothing visible. Revealing the bar first keeps
 * the keyboard path leading to the same picker as the pointer path, the way `activateSecondarySidebarViewContainer`
 * already reveals its panel before selecting a view.
 */
export function beginSessionCreation(
    projectId: string,
    anchor: CreateSessionAnchor = 'heading',
): void {
    const defaultAgent = getBootstrap()?.settings['session.defaultAgent'];
    if (defaultAgent) {
        // Fire-and-forget: `createSession` funnels its own failures into a toast via `tryCommand`.
        void createSession(projectId, defaultAgent);
        return;
    }
    openSessionCreationMenu(projectId, anchor);
}

/**
 * Opens the anchored Agent list even when a default Agent is configured: the Project heading's button creates the
 * default on press and opens this list on hover.
 */
export function openSessionCreationMenu(projectId: string, anchor: CreateSessionAnchor): void {
    if (!useChromeLayoutStore.getState().primarySidebarVisible)
        useChromeLayoutStore.getState().setPrimarySidebarVisible(true);
    useDialogStore.getState().openCreateSessionMenu(projectId, anchor);
}

/**
 * Commits the anchored Session-creation menu's choice. `null` is the deliberate "no Terminal" escape hatch and is not
 * recorded as a preference, since it names no Terminal the menu could lead with next time.
 */
export function chooseSessionTerminalKind(projectId: string, kind: TerminalKind | null): void {
    useDialogStore.getState().closeCreateSessionMenu();
    // Fire-and-forget: `createSession` funnels its own failures into a toast via `tryCommand`.
    void createSession(projectId, kind);
}

/**
 * Adding a hidden Project's folder again brings its Sessions back, so the flow selects one of them instead of asking
 * for a Terminal and creating yet another Session next to the restored ones.
 */
async function restoreHiddenProject(rootPath: string): Promise<void> {
    const project = await caxri.request('project.create', { rootPath });
    await refreshWorkbench();
    selectProject(project.id);
}

/**
 * The native picker sees only this Mac's disk, so an SSH Host window chooses from the folders its own Server lists.
 * Either way the rest of the flow is the same: Main's `project.create` treats the SSH Host's folder as remote and
 * grants nothing locally. Before the window's environment is known neither picker is safe, so the command does
 * nothing.
 */
function selectProjectFolder(): Promise<string | null | undefined> {
    if (isLocalOnlyAvailable()) return caxri.request('dialog.selectDirectory');
    return isSshHost() ? pickSshHostFolder() : Promise.resolve(undefined);
}

export async function chooseProjectFolder(): Promise<void> {
    await tryCommand(translate('session.errors.selectFolderFailed'), async () => {
        const rootPath = await selectProjectFolder();
        if (!rootPath) return;
        if (await caxri.request('project.restorable', { rootPath })) {
            await restoreHiddenProject(rootPath);
            return;
        }
        const defaultAgent = getBootstrap()?.settings['session.defaultAgent'];
        if (defaultAgent) await createProjectSession(rootPath, defaultAgent);
        else useDialogStore.getState().askAgentForRoot(rootPath);
    });
}

/**
 * The folder-picker grant is a single-use Main-process authorization, so abandoning the Agent choice must revoke it
 * instead of leaving the root reachable.
 */
export function cancelPendingSession(): void {
    const pendingRoot = useDialogStore.getState().pendingRoot;
    if (pendingRoot) {
        // Fire-and-forget: revoking an abandoned folder-picker grant has no UI-visible outcome
        // to await, and a failure here has nothing left to affect besides the grant itself.
        void caxri.request('project.cancelCreate', { rootPath: pendingRoot });
    }
    clearPendingSession();
}

export function confirmPendingSession(kind: TerminalKind | null): void {
    const { pendingRoot, pendingProjectId } = useDialogStore.getState();
    // Fire-and-forget: both `createProjectSession` and `createSession` funnel their own failures
    // into a toast via `tryCommand`.
    if (pendingRoot) {
        void createProjectSession(pendingRoot, kind);
    } else if (pendingProjectId) {
        void createSession(pendingProjectId, kind);
    }
}
