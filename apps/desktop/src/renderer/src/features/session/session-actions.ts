import type { ProjectRecord, SessionRecord, TerminalKind, TerminalRecord } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import type { SessionMruShortcutInvocation } from '../../commands/registry';
import { caxri } from '../../lib/caxri';
import { queryClient } from '../../queries/client';
import { removeSessionQueries } from '../../queries/invalidation';
import { clearPendingSession, useDialogStore } from '../../stores/dialogs';
import { getBootstrap, getSelectedSession, selectSelectedProject } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import { tryCommand } from '../../stores/toasts';
import { refreshWorkbench, registerSessionSelectionConvergence } from '../../stores/workbench';
import { beginRendererPerformanceRequest } from '../renderer-performance/controller';
import { activeSessionsInSidebarOrder } from './session-activity-order';
import type { PendingSessionMruSelection } from './session-mru-switcher-state';
import {
    resolveSessionMruNavigation,
    useSessionMruSwitcherStore,
} from './session-mru-switcher-state';
import type { SessionNavigationDirection } from './session-navigation-history';
import { useSessionNavigationHistoryStore } from './session-navigation-history';

const mruNavigationState: { pendingSelection?: PendingSessionMruSelection } = {};

export function canResumeAutomaticSessionNaming(
    session: Pick<SessionRecord, 'autoNamingState' | 'titleMode'>,
    terminal?: Pick<TerminalRecord, 'provider'>,
): boolean {
    const provider = terminal?.provider;
    return (
        (session.autoNamingState === 'stopped' || session.titleMode === 'manual') &&
        provider !== undefined &&
        agentProviderCatalog[provider].automaticSessionNaming === 'caxri'
    );
}

/**
 * `session.select` publishes a full `state.changed` event before returning its result. That event is the convergence
 * path; register before sending so delayed Preload event replay still settles history after the event-driven snapshot,
 * without queueing a second full `app.bootstrap` behind it.
 */
async function didRequestSelection(sessionId: string): Promise<boolean> {
    const convergence = registerSessionSelectionConvergence();
    const finishPerformanceRequest = beginRendererPerformanceRequest('session.select');
    const selected = await tryCommand('Session selection failed', async () => {
        try {
            return await caxri.request('session.select', { sessionId });
        } finally {
            finishPerformanceRequest();
        }
    });
    if (selected === undefined) {
        convergence.cancel();
        return false;
    }
    await convergence.promise;
    return true;
}

/**
 * Every Session selection the Renderer issues, history navigation aside, reports itself to the visit history. Leaving
 * that to the observed Workbench snapshot cannot work: the snapshot carries no attribution, so a selection that races a
 * history navigation is indistinguishable from that navigation's own echo.
 */
async function didRequestSessionSelection(sessionId: string): Promise<boolean> {
    useSessionNavigationHistoryStore.getState().beginSelection();
    const selected = await didRequestSelection(sessionId);
    useSessionNavigationHistoryStore.getState().settleSelection(sessionId, selected);
    return selected;
}

export async function didSelectSession(sessionId: string): Promise<boolean> {
    delete mruNavigationState.pendingSelection;
    return didRequestSessionSelection(sessionId);
}

/**
 * Records the logical selection synchronously so another quick-toggle can reverse direction before Server's full
 * snapshot refresh completes. Server remains authoritative: the pending link disappears when its refreshed selected
 * Session arrives, and a failed request or any ordinary Session selection clears it.
 */
function selectMruSession(sessionId: string): void {
    const bootstrap = getBootstrap();
    if (!bootstrap) return;
    const navigation = resolveSessionMruNavigation(
        bootstrap.sessions,
        bootstrap.selectedSessionId,
        mruNavigationState.pendingSelection,
    );
    const previousSessionId = navigation.selectedSessionId;
    if (!previousSessionId || previousSessionId === sessionId) return;
    mruNavigationState.pendingSelection = { currentSessionId: sessionId, previousSessionId };
    // Fire-and-forget: the request funnels failures into a toast and completion only reconciles optimistic MRU data.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void didRequestSessionSelection(sessionId).then((selected) => {
        if (mruNavigationState.pendingSelection?.currentSessionId !== sessionId) return;
        if (!selected || getBootstrap()?.selectedSessionId === sessionId)
            delete mruNavigationState.pendingSelection;
    });
}

async function createSession(projectId: string, defaultAgent: TerminalKind | null): Promise<void> {
    await tryCommand(
        'Session creation failed',
        async () => {
            await caxri.request('session.create', { projectId, defaultAgent });
            clearPendingSession();
        },
        { refresh: refreshWorkbench },
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

export async function chooseProjectFolder(): Promise<void> {
    await tryCommand('Project folder selection failed', async () => {
        const rootPath = await caxri.request('dialog.selectDirectory');
        if (!rootPath) return;
        const defaultAgent = getBootstrap()?.settings['session.defaultAgent'];
        if (defaultAgent) await createProjectSession(rootPath, defaultAgent);
        else useDialogStore.getState().askAgentForRoot(rootPath);
    });
}

export function selectProject(projectId: string): void {
    const bootstrap = getBootstrap();
    const session = bootstrap
        ? activeSessionsInSidebarOrder(bootstrap.projects, bootstrap.sessions).find(
              (item) => item.projectId === projectId,
          )
        : undefined;
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
        { refresh: refreshWorkbench },
    );
}

export function archiveSelectedSession(): void {
    const session = getSelectedSession();
    if (session) archiveSession(session.id);
}

/**
 * Codex refuses to open one conversation in two processes, so handing a Session to an editor Terminal means Caxri must
 * stop its own Agent first. `session.detach` parks the Agent Terminals as `detached`; unlike background suspension,
 * selecting the Session again does not relaunch them — only `resumeSession` does.
 */
export function detachSession(sessionId: string): void {
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Session detach failed', () => caxri.request('session.detach', { sessionId }), {
        refresh: refreshWorkbench,
    });
}

export function resumeSession(sessionId: string): void {
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Session resume failed', () => caxri.request('session.resume', { sessionId }), {
        refresh: refreshWorkbench,
    });
}

export function detachSelectedSession(): void {
    const session = getSelectedSession();
    if (session) detachSession(session.id);
}

export function resumeSelectedSession(): void {
    const session = getSelectedSession();
    if (session) resumeSession(session.id);
}

/**
 * True when the Session has at least one Agent Terminal parked by `detachSession`, i.e. the menu should offer Resume
 * instead of Detach.
 */
export function hasDetachedAgentTerminal(
    sessionId: string,
    terminals: ReadonlyArray<Pick<TerminalRecord, 'lastProcessState' | 'provider' | 'sessionId'>>,
): boolean {
    return terminals.some(
        (terminal) =>
            terminal.sessionId === sessionId &&
            terminal.provider !== undefined &&
            terminal.lastProcessState === 'detached',
    );
}

/**
 * True when the Session has a live Agent Terminal that `detachSession` could hand over.
 */
export function hasLiveAgentTerminal(
    sessionId: string,
    terminals: ReadonlyArray<Pick<TerminalRecord, 'lastProcessState' | 'provider' | 'sessionId'>>,
): boolean {
    return terminals.some(
        (terminal) =>
            terminal.sessionId === sessionId &&
            terminal.provider !== undefined &&
            (terminal.lastProcessState === 'running' || terminal.lastProcessState === 'starting'),
    );
}

export function unarchiveSession(sessionId: string): void {
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand(
        'Session restore failed',
        () => caxri.request('session.unarchive', { sessionId }),
        { refresh: refreshWorkbench },
    );
}

export async function didRenameSession(sessionId: string, displayTitle: string): Promise<boolean> {
    const renamed = await tryCommand(
        'Session rename failed',
        () => caxri.request('session.rename', { sessionId, displayTitle }),
        { refresh: refreshWorkbench },
    );
    return renamed !== undefined;
}

export function resumeAutomaticSessionNaming(sessionId: string): void {
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand(
        'Automatic Session naming could not be resumed',
        () => caxri.request('session.resumeAutomaticNaming', { sessionId }),
        { refresh: refreshWorkbench },
    );
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
        /**
         * The Server deletes the worktree Projects auto-registered on this Project's behalf in the same transaction, so
         * their Sessions disappear too. `refreshWorkbench` only replaces bootstrap state; per-Session view state and
         * cached queries need this explicit cleanup or they would outlive the rows they describe.
         */
        const deletedProjectIds = new Set([
            project.id,
            ...bootstrap.projects
                .filter((candidate) => candidate.ownerProjectId === project.id)
                .map((candidate) => candidate.id),
        ]);
        const removedSessionIds: string[] = [];
        for (const session of bootstrap.sessions)
            if (deletedProjectIds.has(session.projectId)) removedSessionIds.push(session.id);
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
    openProjectInExternalEditor(
        project,
        session?.projectId === project.id ? session.id : undefined,
    );
}

export function openProjectInExternalEditor(
    project: Pick<ProjectRecord, 'rootPath'>,
    sessionId?: string,
): void {
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand('Opening the Project in the external editor failed', () =>
        caxri.request('project.openInEditor', {
            path: project.rootPath,
            ...(sessionId !== undefined && { sessionId }),
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
 * analogous to a browser "move tab to new window". The Server already selects the new Session as part of the same
 * operation, so the post-command bootstrap refresh is all that is needed to reflect the switch, matching
 * `session.create`'s flow. The only-tab constraint is repeated at this request boundary so an accessibility or
 * synthetic activation of a disabled menu item cannot reach the Server.
 */
export function moveTerminalToNewSession(terminalId: string, isOnlyWorkTab = false): void {
    if (isOnlyWorkTab) return;
    // Fire-and-forget: `tryCommand` funnels the request's own failure into a toast internally.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void tryCommand(
        'Move to new session failed',
        () => caxri.request('terminal.moveToNewSession', { terminalId }),
        { refresh: refreshWorkbench },
    );
}

export function selectAdjacentSession(delta: 1 | -1): void {
    const bootstrap = getBootstrap();
    if (!bootstrap) return;
    const activeSessions = activeSessionsInSidebarOrder(bootstrap.projects, bootstrap.sessions);
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

export function switchMruSession(invocation?: SessionMruShortcutInvocation): void {
    const bootstrap = getBootstrap();
    if (!bootstrap) return;
    const navigation = resolveSessionMruNavigation(
        bootstrap.sessions,
        bootstrap.selectedSessionId,
        mruNavigationState.pendingSelection,
    );
    mruNavigationState.pendingSelection = navigation.pendingSelection;
    const immediateSessionId = useSessionMruSwitcherStore
        .getState()
        .beginOrCycle(navigation.candidateIds, invocation);
    // A command-palette invocation, or a binding with no held modifier, is a one-shot jump to the previous Session.
    if (immediateSessionId) selectMruSession(immediateSessionId);
}

/**
 * Walks the Session visit history, browser-style. The history stack is device-local and in-memory: it describes this
 * window's navigation, not persisted Session state, so a relaunch legitimately starts with an empty stack.
 */
export function navigateSessionHistory(direction: SessionNavigationDirection): void {
    const request = useSessionNavigationHistoryStore.getState().request(direction);
    if (!request) return;
    delete mruNavigationState.pendingSelection;
    // Fire-and-forget: `didRequestSelection` funnels its own failures into a toast via `tryCommand`; the only thing
    // left to do here is report the outcome back, so the history moves only for a navigation that actually happened.
    // The request already registered itself with the history, which is why this does not go through
    // `didRequestSessionSelection`.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void didRequestSelection(request.target).then((selected) => {
        const history = useSessionNavigationHistoryStore.getState();
        if (selected) history.confirm(request);
        else history.abandon(request);
    });
}

export function canNavigateSessionHistory(direction: SessionNavigationDirection): boolean {
    const history = useSessionNavigationHistoryStore.getState();
    return direction === 'back' ? history.canGoBack : history.canGoForward;
}

export function commitMruSession(): void {
    const state = useSessionMruSwitcherStore.getState();
    const sessions = getBootstrap()?.sessions ?? [];
    const availableCandidateIds = state.candidateIds.filter((id) =>
        sessions.some((session) => session.id === id && session.archivedAt === undefined),
    );
    const sessionId = state.commit(availableCandidateIds);
    if (sessionId) selectMruSession(sessionId);
}
