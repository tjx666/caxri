import type { AgentProvider, TerminalKind } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { isPrimarySidebarShown, useChromeLayoutStore } from '../../stores/chrome-layout';
import type { CreateSessionAnchor } from '../../stores/dialogs';
import { clearPendingSession, useDialogStore } from '../../stores/dialogs';
import { useEnvironmentStore } from '../../stores/environment';
import { getBootstrap } from '../../stores/selectors';
import { pushToast, tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import { pickProjectMachine, pickSshHostFolder } from '../ssh-host/ssh-host-dialogs-store';
import { typeAgentSignInCommand } from '../terminal/agent-sign-in';
import { newAgentSurface } from '../terminal/new-terminal-agent';
import {
    rememberActivitySessionProject,
    useActivitySessionProjectStore,
} from './activity-session-project-store';
import { rememberLastAgentChoice, useLastAgentChoiceStore } from './last-agent-choice-store';
import { selectProject } from './session-commands';

/**
 * Resolves the new Session's Terminal id, or `undefined` for a Session without one or a failure (already reported in a
 * toast).
 */
function createSession(
    projectId: string,
    defaultAgent: TerminalKind | null,
): Promise<string | undefined> {
    return tryCommand(
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
            const created = await caxri.request('session.create', {
                projectId,
                defaultAgent,
                ...(surface === 'chat' && { surface }),
            });
            clearPendingSession();
            return created.terminal?.id;
        },
        { refresh: refreshWorkbench },
    );
}

function createProjectSession(
    rootPath: string,
    defaultAgent: TerminalKind | null,
    environmentId: string | undefined,
): Promise<string | undefined> {
    return tryCommand(translate('session.errors.createProjectFailed'), async () => {
        const project = await caxri.in(environmentId).request('project.create', { rootPath });
        /**
         * Keeps the Agent-choice dialog open, now anchored to the created Project.
         */
        useDialogStore.getState().askAgentForProject(project.id);
        return createSession(project.id, defaultAgent);
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
 * The Terminal a press on a split New Session control starts (the Project heading's pencil and the Activity view's
 * row): the configured default Agent, else the kind the user last picked from a New Session list. `undefined` means the
 * press opens the list instead. Only the split controls fall back to the last pick, because each still offers the full
 * list beside its press; the empty-Project row and the `session.create` command keep "Ask each time" literal.
 */
function splitPressKind(): TerminalKind | undefined {
    return (
        getBootstrap()?.settings['session.defaultAgent'] ?? useLastAgentChoiceStore.getState().kind
    );
}

/**
 * Handles a press on a split New Session control; see `splitPressKind`. With nothing to repeat it opens that control's
 * own list.
 */
export function pressSplitNewSession(projectId: string, anchor: 'heading' | 'activity'): void {
    const kind = splitPressKind();
    if (!kind) {
        openSessionCreationMenu(projectId, anchor);
        return;
    }
    // Fire-and-forget: `createSession` funnels its own failures into a toast via `tryCommand`.
    void createSession(projectId, kind);
}

/**
 * Opens the anchored Agent list even when a default Agent is configured: the Project heading's button creates the
 * default on press and opens this list on hover.
 */
export function openSessionCreationMenu(projectId: string, anchor: CreateSessionAnchor): void {
    const layout = useChromeLayoutStore.getState();
    if (!isPrimarySidebarShown(layout)) layout.setPrimarySidebarVisible(true);
    /**
     * While the side bar shows Activity no Project heading is mounted, so a heading claim (the default for the command
     * palette, the native menu, and the shortcut) would open nothing; the Activity view's New Session row takes it, and
     * opens on the Project that row names (its remembered pick) so the shortcut and the row agree. A remembered Project
     * that is no longer listed falls back inside the row to its own default.
     */
    if (anchor === 'heading' && layout.primarySidebarActivityMode) {
        const remembered = useActivitySessionProjectStore.getState().projectId;
        useDialogStore.getState().openCreateSessionMenu(remembered ?? projectId, 'activity');
        return;
    }
    useDialogStore.getState().openCreateSessionMenu(projectId, anchor);
}

/**
 * Re-targets the open Activity New Session list at another Project and remembers it as that row's target.
 */
export function chooseActivitySessionProject(projectId: string): void {
    rememberActivitySessionProject(projectId);
    openSessionCreationMenu(projectId, 'activity');
}

/**
 * Commits the anchored Session-creation menu's choice and remembers it for the heading button's press. `null` is the
 * deliberate "no Terminal" escape hatch and is not remembered (see `rememberLastAgentChoice`).
 */
export function chooseSessionTerminalKind(projectId: string, kind: TerminalKind | null): void {
    useDialogStore.getState().closeCreateSessionMenu();
    rememberLastAgentChoice(kind);
    // Fire-and-forget: `createSession` funnels its own failures into a toast via `tryCommand`.
    void createSession(projectId, kind);
}

/**
 * A New Session menu's "Sign in…" on a signed-out Agent: a Shell Session in the Project with the Agent's sign-in
 * command typed at its prompt (`typeAgentSignInCommand`). It is not remembered as the last pick: the user still wants
 * the Agent, not a Shell, once signed in.
 */
export function chooseSessionSignIn(projectId: string, command: string): void {
    useDialogStore.getState().closeCreateSessionMenu();
    void signInInNewSession(createSession(projectId, 'shell'), command);
}

async function signInInNewSession(
    creation: Promise<string | undefined>,
    command: string,
): Promise<void> {
    const terminalId = await creation;
    if (terminalId) await typeAgentSignInCommand(terminalId, command);
}

/**
 * Adding a hidden Project's folder again brings its Sessions back, so the flow selects one of them instead of asking
 * for a Terminal and creating yet another Session next to the restored ones.
 */
async function restoreHiddenProject(
    rootPath: string,
    environmentId: string | undefined,
): Promise<void> {
    const project = await caxri.in(environmentId).request('project.create', { rootPath });
    await refreshWorkbench();
    selectProject(project.id);
}

/**
 * The native picker sees only this Mac's disk, so a Project on an SSH Host is chosen from the folders that Host's
 * Server lists. Either way the rest of the flow is the same: Main's `project.create` treats the SSH Host's folder as
 * remote and grants nothing locally.
 */
function selectProjectFolder(
    environmentId: string | undefined,
): Promise<string | null | undefined> {
    return environmentId === undefined
        ? caxri.in(undefined).request('dialog.selectDirectory')
        : pickSshHostFolder(environmentId);
}

/**
 * Adds a Project on one machine. Without an explicit machine it is the one running the selected Session, so a user
 * working in an SSH Host's Session adds the next Project there, as in a window of that Host.
 *
 * @param environmentId The SSH Host to add the Project on, or `undefined` for this Mac.
 */
export async function chooseProjectFolder(
    environmentId: string | undefined = useEnvironmentStore.getState().selectedEnvironmentId,
): Promise<void> {
    await tryCommand(translate('session.errors.selectFolderFailed'), async () => {
        const rootPath = await selectProjectFolder(environmentId);
        if (!rootPath) return;
        const target = caxri.in(environmentId);
        if (await target.request('project.restorable', { rootPath })) {
            await restoreHiddenProject(rootPath, environmentId);
            return;
        }
        const defaultAgent = getBootstrap()?.settings['session.defaultAgent'];
        if (defaultAgent) await createProjectSession(rootPath, defaultAgent, environmentId);
        else useDialogStore.getState().askAgentForRoot(rootPath, environmentId);
    });
}

/**
 * Add Project: asks which machine first while an SSH Host is connected, then opens that machine's folder picker (the
 * native dialog for this Mac, the folder browser for an SSH Host). With no Host connected it goes straight to this
 * Mac's folder dialog, as before multi-host.
 */
export async function addProject(): Promise<void> {
    const isAnyHostConnected = useEnvironmentStore
        .getState()
        .hosts.some((host) => host.phase === 'connected');
    if (!isAnyHostConnected) {
        await chooseProjectFolder(undefined);
        return;
    }
    const choice = await pickProjectMachine();
    if (choice) await chooseProjectFolder(choice.environmentId);
}

/**
 * The folder-picker grant is a single-use Main-process authorization, so abandoning the Agent choice must revoke it
 * instead of leaving the root reachable.
 */
export function cancelPendingSession(): void {
    const { pendingRoot, pendingRootEnvironmentId } = useDialogStore.getState();
    if (pendingRoot) {
        // Fire-and-forget: revoking an abandoned folder-picker grant has no UI-visible outcome
        // to await, and a failure here has nothing left to affect besides the grant itself.
        void caxri
            .in(pendingRootEnvironmentId)
            .request('project.cancelCreate', { rootPath: pendingRoot });
    }
    clearPendingSession();
}

/**
 * Main keeps the folder-picker grant for 60 seconds (`ProjectRootGrants`, apps/desktop/src/main/root-grants.ts). The
 * margin leaves room for the resume click and the `project.create` round trip.
 */
const ROOT_GRANT_RESUME_WINDOW_MS = 50_000;

/**
 * Whether a pending folder grant from `grantedAt` is too old to survive a resume. Only the Add Project path holds a
 * grant; an existing Project (`pendingProjectId`) never expires.
 */
export function isPendingRootGrantStale(grantedAt: number | undefined, now: number): boolean {
    return grantedAt !== undefined && now - grantedAt > ROOT_GRANT_RESUME_WINDOW_MS;
}

/**
 * Hides the Agent dialog and opens Settings at the uninstalled Agent's executable row. Unlike a dismissal it keeps the
 * pending Project and its folder grant, so the user returns to the same choice instead of picking the folder again.
 */
export function configurePendingAgent(provider: AgentProvider): void {
    const dialogs = useDialogStore.getState();
    dialogs.suspendPending();
    dialogs.openSettings('agent-executable', provider);
}

/**
 * Brings the Agent dialog back after Settings. A lapsed folder grant cannot be spent, so it is dropped and the folder
 * picker reopens with an explanation instead of failing later with `PATH_DENIED` on the Agent click.
 */
export function resumePendingSession(): void {
    const { pendingRoot, pendingRootEnvironmentId, pendingRootGrantedAt } =
        useDialogStore.getState();
    if (pendingRoot && isPendingRootGrantStale(pendingRootGrantedAt, Date.now())) {
        cancelPendingSession();
        pushToast('warning', translate('session.createDialog.grantExpired'), { history: false });
        void chooseProjectFolder(pendingRootEnvironmentId);
        return;
    }
    useDialogStore.getState().resumePending();
}

/**
 * The creation the centered dialog is waiting on. The dialog stays open until `project.create` and `session.create`
 * both answer, so on a slow machine a double-click or a second Enter on a tile used to start a second creation and
 * leave the new Project with two Sessions. Later activations are ignored until this one settles; a failure settles it
 * too, so the still-open dialog can retry.
 */
const pendingConfirmation: { current: Promise<void> | undefined } = { current: undefined };

async function settleConfirmation(creation: Promise<unknown>): Promise<void> {
    try {
        await creation;
    } finally {
        pendingConfirmation.current = undefined;
    }
}

export function confirmPendingSession(kind: TerminalKind | null): void {
    if (pendingConfirmation.current) return;
    rememberLastAgentChoice(kind);
    const creation = createPendingSession(kind);
    if (creation) pendingConfirmation.current = settleConfirmation(creation);
}

/**
 * The Agent-choice dialog's "Sign in…" on a signed-out Agent tile; see `chooseSessionSignIn`.
 */
export function confirmPendingSignIn(command: string): void {
    if (pendingConfirmation.current) return;
    const creation = createPendingSession('shell');
    if (creation)
        pendingConfirmation.current = settleConfirmation(signInInNewSession(creation, command));
}

function createPendingSession(kind: TerminalKind | null): Promise<string | undefined> | undefined {
    const { pendingRoot, pendingRootEnvironmentId, pendingProjectId } = useDialogStore.getState();
    // Both `createProjectSession` and `createSession` funnel their own failures into a toast via `tryCommand`.
    return pendingRoot
        ? createProjectSession(pendingRoot, kind, pendingRootEnvironmentId)
        : pendingProjectId
          ? createSession(pendingProjectId, kind)
          : undefined;
}
